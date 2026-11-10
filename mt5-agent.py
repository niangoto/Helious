#!/usr/bin/env python3
"""
HEROS MT5 агент — работи на Windows компютъра, където е MetaTrader 5.

Свързва се ИЗХОДЯЩО към сайта на HEROS (без отворени портове), взима команди
(snapshot / order_open / order_close / order_modify / symbols) и ги изпълнява
в локалния MT5 терминал.

Изисква:  pip install MetaTrader5 requests
Конфиг:   mt5-agent.config.json до този файл (виж mt5-agent.config.example.json)
Пускане:  python mt5-agent.py
Kill switch: създай файл с име KILL до агента — спира отварянето на нови позиции
             (затварянето остава позволено). Изтрий го, за да продължи.
"""

import json
import os
import socket
import sys
import time
import traceback
from datetime import datetime, timedelta

import requests

try:
    import MetaTrader5 as mt5
except ImportError:
    print("Липсва пакетът MetaTrader5: pip install MetaTrader5")
    sys.exit(1)

VERSION = "1.1"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "mt5-agent.config.json")
KILL_FILE = os.path.join(HERE, "KILL")

TF = {
    "1m": mt5.TIMEFRAME_M1, "5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15,
    "30m": mt5.TIMEFRAME_M30, "1h": mt5.TIMEFRAME_H1, "4h": mt5.TIMEFRAME_H4,
    "1d": mt5.TIMEFRAME_D1,
}
MARGIN_MODES = {0: "netting", 1: "exchange", 2: "hedging"}


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def load_config():
    cfg = {
        "server_url": os.environ.get("HEROS_URL", ""),
        "token": os.environ.get("HEROS_TOKEN", ""),
        "max_volume": 1.0,            # макс. обем (лотове) на една поръчка
        "max_positions": 10,          # макс. брой позиции с magic на HEROS
        "allowed_symbols": [],        # празно = всички; иначе само тези
        "deviation": 20,              # допустимо подхлъзване (пунктове)
        "server_utc_offset_hours": None,  # ако е null — определя се автоматично
        "mt5_path": None,             # път до terminal64.exe (по избор)
        "mt5_login": None, "mt5_password": None, "mt5_server": None,  # по избор
    }
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    cfg["server_url"] = cfg["server_url"].rstrip("/")
    if not cfg["server_url"] or not cfg["token"]:
        print("Попълни server_url и token в mt5-agent.config.json")
        sys.exit(1)
    return cfg


CFG = load_config()
SESSION = requests.Session()
SESSION.headers.update({"Authorization": "Bearer " + CFG["token"]})

_tz_offset = None           # секунди: време на сървъра на брокера − UTC
_margin_cache = {}


def api(method, path, **kw):
    return SESSION.request(method, CFG["server_url"] + path, **kw)


# ── MT5 помощни ────────────────────────────────────────────
def init_mt5():
    kw = {}
    if CFG.get("mt5_path"):
        kw["path"] = CFG["mt5_path"]
    if CFG.get("mt5_login"):
        kw.update(login=int(CFG["mt5_login"]), password=CFG["mt5_password"], server=CFG["mt5_server"])
    if not mt5.initialize(**kw):
        raise RuntimeError("MT5 initialize неуспешно: %s" % (mt5.last_error(),))


def ensure_mt5():
    if mt5.terminal_info() is None or mt5.account_info() is None:
        mt5.shutdown()
        init_mt5()


def update_offset(tick):
    """Определя разликата между часа на сървъра на брокера и UTC."""
    global _tz_offset
    if CFG.get("server_utc_offset_hours") is not None:
        _tz_offset = int(float(CFG["server_utc_offset_hours"]) * 3600)
        return
    if tick is None or not tick.time:
        return
    cand = tick.time - time.time()
    rounded = round(cand / 1800.0) * 1800
    # приемаме само ако е близо до кратно на 30 мин (свеж тик), иначе пазим старото
    if abs(cand - rounded) < 120 and abs(rounded) <= 14 * 3600:
        _tz_offset = int(rounded)


def off():
    return _tz_offset or 0


def to_utc(server_ts):
    return int(server_ts) - off()


def from_utc_dt(ts):
    return datetime.utcfromtimestamp(int(ts) + off())


def account_dict():
    a = mt5.account_info()
    t = mt5.terminal_info()
    if a is None:
        return None
    return {
        "login": a.login, "server": a.server, "company": a.company, "currency": a.currency,
        "balance": a.balance, "equity": a.equity, "margin": a.margin, "margin_free": a.margin_free,
        "margin_level": a.margin_level, "profit": a.profit, "leverage": a.leverage,
        "demo": a.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO,
        "margin_mode": MARGIN_MODES.get(a.margin_mode, str(a.margin_mode)),
        # сметката позволява търговия И алгоритмичната търговия е включена в терминала
        "trade_allowed": bool(a.trade_allowed and a.trade_expert and t is not None and t.trade_allowed),
    }


def pos_dict(p):
    return {
        "ticket": p.ticket, "symbol": p.symbol,
        "type": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
        "volume": p.volume, "price_open": p.price_open, "price_current": p.price_current,
        "sl": p.sl, "tp": p.tp, "profit": p.profit, "swap": p.swap,
        "commission": getattr(p, "commission", 0.0), "time": to_utc(p.time),
        "magic": p.magic, "comment": p.comment,
    }


def closed_trades(magic, from_ts, open_ids):
    """Затворени позиции с даден magic, сглобени от сделките (in/out)."""
    start = from_utc_dt(from_ts - 86400)
    end = from_utc_dt(time.time() + 86400)
    deals = mt5.history_deals_get(start, end)
    if not deals:
        return []
    groups = {}
    for d in deals:
        if d.position_id:
            groups.setdefault(d.position_id, []).append(d)
    out = []
    for pid, ds in groups.items():
        if pid in open_ids:
            continue
        ins = [d for d in ds if d.entry == mt5.DEAL_ENTRY_IN]
        outs = [d for d in ds if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)]
        if not ins or not outs or ins[0].magic != magic:
            continue
        i, o = ins[0], outs[-1]
        if to_utc(o.time) < from_ts:
            continue
        vol = sum(d.volume for d in ins)
        reason = {mt5.DEAL_REASON_SL: "SL", mt5.DEAL_REASON_TP: "TP", mt5.DEAL_REASON_SO: "SO"}.get(o.reason, "OTHER")
        out.append({
            "ticket": pid, "symbol": i.symbol,
            "type": "BUY" if i.type == mt5.DEAL_TYPE_BUY else "SELL",
            "volume": vol, "price_open": i.price, "price_close": o.price,
            "time_open": to_utc(i.time), "time_close": to_utc(o.time),
            "profit": sum(d.profit for d in ds), "swap": sum(d.swap for d in ds),
            "commission": sum(d.commission + getattr(d, "fee", 0.0) for d in ds),
            "reason": reason,
        })
    return out


def symbol_data(req):
    name = req["name"]
    info = mt5.symbol_info(name)
    if info is None:
        return {"error": "Символът не съществува в MT5 (провери името и суфикса)"}
    if not info.visible and not mt5.symbol_select(name, True):
        return {"error": "Символът не може да се добави в Market Watch"}
    tick = mt5.symbol_info_tick(name)
    if tick is None:
        return {"error": "Няма тик за символа"}
    update_offset(tick)
    now = time.time()
    tick_age = now - to_utc(tick.time) if tick.time else 1e9
    allowed = info.trade_mode == mt5.SYMBOL_TRADE_MODE_FULL

    m = _margin_cache.get(name)
    if not m or now - m[0] > 60:
        mv = mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, name, 1.0, tick.ask or tick.bid)
        m = (now, mv or 0.0)
        _margin_cache[name] = m

    tf = TF.get(req.get("interval", "1h"), mt5.TIMEFRAME_H1)
    full = req.get("from", 0) <= 0
    count = int(req.get("count", 2000)) if full else 6
    rates = mt5.copy_rates_from_pos(name, tf, 0, count)
    candles = []
    if rates is not None:
        for r in rates:
            candles.append([to_utc(r["time"]), float(r["open"]), float(r["high"]), float(r["low"]),
                            float(r["close"]), float(r["tick_volume"])])
    return {
        "bid": tick.bid, "ask": tick.ask, "point": info.point, "digits": info.digits,
        "contract": info.trade_contract_size, "vmin": info.volume_min, "vmax": info.volume_max,
        "vstep": info.volume_step, "tick_value": info.trade_tick_value, "tick_size": info.trade_tick_size,
        "swap_long": info.swap_long, "swap_short": info.swap_short, "swap_mode": info.swap_mode,
        "margin_1lot": m[1], "trade_allowed": allowed, "tick_age": tick_age,
        "stops_level": info.trade_stops_level, "candles": candles, "candles_full": full,
    }


# ── Команди ────────────────────────────────────────────────
def cmd_snapshot(p):
    ensure_mt5()
    syms = {}
    for r in p.get("symbols", []):
        try:
            syms[r["name"]] = symbol_data(r)
        except Exception as e:
            syms[r["name"]] = {"error": str(e)}
    positions = [pos_dict(x) for x in (mt5.positions_get() or [])]
    deals = []
    if p.get("magic"):
        open_ids = {x["ticket"] for x in positions}
        deals = closed_trades(p["magic"], int(p.get("historyFrom", 0)), open_ids)
    return {"account": account_dict(), "symbols": syms, "positions": positions, "deals": deals}


def cmd_symbols(p):
    ensure_mt5()
    q = (p.get("query") or "").strip()
    lst = mt5.symbols_get("*%s*" % q) if q else mt5.symbols_get()
    out = []
    for s in (lst or [])[:60]:
        out.append({"name": s.name, "description": s.description, "path": s.path})
    return out


def filling_for(info):
    fm = info.filling_mode
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    if fm & 1:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


def norm_volume(info, vol):
    step = info.volume_step or 0.01
    v = round(round(vol / step) * step, 8)
    return max(info.volume_min, min(info.volume_max, v))


def check_result(res, what):
    if res is None:
        raise RuntimeError("%s: няма отговор (%s)" % (what, mt5.last_error()))
    if res.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL):
        raise RuntimeError("%s: retcode %s — %s" % (what, res.retcode, res.comment))


def cmd_order_open(p):
    ensure_mt5()
    if os.path.exists(KILL_FILE):
        raise RuntimeError("Kill switch е активен (файл KILL) — нови позиции са спрени")
    sym = p["symbol"]
    if CFG["allowed_symbols"] and sym not in CFG["allowed_symbols"]:
        raise RuntimeError("Символът %s не е в allowed_symbols на агента" % sym)
    a = account_dict()
    if not a or not a["trade_allowed"]:
        raise RuntimeError("Търговията не е разрешена (Algo Trading изключен или сметката е само за четене)")
    mine = [x for x in (mt5.positions_get() or []) if x.magic == p["magic"]]
    if len(mine) >= CFG["max_positions"]:
        raise RuntimeError("Достигнат лимит max_positions (%d) на агента" % CFG["max_positions"])
    info = mt5.symbol_info(sym)
    if info is None:
        raise RuntimeError("Символът не съществува: " + sym)
    if not info.visible:
        mt5.symbol_select(sym, True)
    vol = norm_volume(info, float(p["volume"]))
    if vol > CFG["max_volume"] + 1e-9:
        raise RuntimeError("Обем %s надвишава max_volume (%s) на агента" % (vol, CFG["max_volume"]))
    tick = mt5.symbol_info_tick(sym)
    buy = p["side"] == "BUY"
    price = tick.ask if buy else tick.bid
    d = info.digits
    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": sym, "volume": vol,
        "type": mt5.ORDER_TYPE_BUY if buy else mt5.ORDER_TYPE_SELL, "price": price,
        "sl": round(float(p["sl"]), d) if p.get("sl") else 0.0,
        "tp": round(float(p["tp"]), d) if p.get("tp") else 0.0,
        "deviation": CFG["deviation"], "magic": int(p["magic"]),
        "comment": str(p.get("comment", "HEROS"))[:30],
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": filling_for(info),
    }
    chk = mt5.order_check(req)      # проверка преди изпращане — дава точната причина за отказ
    if chk is None:
        raise RuntimeError("order_check: няма отговор (%s)" % (mt5.last_error(),))
    if chk.retcode != 0:
        raise RuntimeError("MT5 отказва поръчката: retcode %s — %s (SL %s, TP %s, цена %s, обем %s)" % (
            chk.retcode, chk.comment, req["sl"], req["tp"], price, vol))
    res = mt5.order_send(req)
    check_result(res, "order_send")
    ticket = res.order
    try:  # при hedging позицията има ticket = position_id на сделката
        dl = mt5.history_deals_get(ticket=res.deal)
        if dl and dl[0].position_id:
            ticket = dl[0].position_id
    except Exception:
        pass
    log("OPEN", sym, p["side"], vol, "@", res.price, "ticket", ticket)
    return {"ticket": ticket, "price": res.price, "volume": res.volume or vol, "retcode": res.retcode}


def cmd_order_close(p):
    ensure_mt5()
    poss = mt5.positions_get(ticket=int(p["ticket"]))
    if not poss:
        return {"closed": False, "note": "Позицията вече не съществува"}
    pos = poss[0]
    info = mt5.symbol_info(pos.symbol)
    tick = mt5.symbol_info_tick(pos.symbol)
    buy = pos.type == mt5.POSITION_TYPE_BUY
    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": pos.symbol, "volume": pos.volume,
        "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
        "price": tick.bid if buy else tick.ask, "position": pos.ticket,
        "deviation": CFG["deviation"], "magic": pos.magic,
        "comment": str(p.get("comment", "HEROS"))[:30],
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": filling_for(info),
    }
    res = mt5.order_send(req)
    check_result(res, "close")
    log("CLOSE", pos.symbol, pos.ticket, "@", res.price)
    return {"closed": True, "price": res.price}


def cmd_order_modify(p):
    ensure_mt5()
    poss = mt5.positions_get(ticket=int(p["ticket"]))
    if not poss:
        raise RuntimeError("Няма такава позиция")
    pos = poss[0]
    d = mt5.symbol_info(pos.symbol).digits
    req = {
        "action": mt5.TRADE_ACTION_SLTP, "symbol": pos.symbol, "position": pos.ticket,
        "sl": round(float(p.get("sl", pos.sl)), d), "tp": round(float(p.get("tp", pos.tp)), d),
    }
    check_result(mt5.order_send(req), "modify")
    return {"modified": True}


HANDLERS = {
    "snapshot": cmd_snapshot, "symbols": cmd_symbols, "order_open": cmd_order_open,
    "order_close": cmd_order_close, "order_modify": cmd_order_modify,
}


def run_command(c):
    try:
        data = HANDLERS[c["type"]](c.get("payload") or {})
        body = {"id": c["id"], "ok": True, "data": data}
    except Exception as e:
        log("ГРЕШКА", c.get("type"), e)
        body = {"id": c["id"], "ok": False, "error": str(e)}
    api("POST", "/api/mt5/agent/result", json=body, timeout=30)


def main():
    init_mt5()
    a = account_dict()
    log("MT5 OK: сметка %s @ %s (%s), баланс %s %s" % (a["login"], a["server"], "DEMO" if a["demo"] else "РЕАЛНА", a["balance"], a["currency"]))
    if not a["demo"]:
        log("ВНИМАНИЕ: това е РЕАЛНА сметка.")
    backoff = 2
    while True:
        try:
            r = api("POST", "/api/mt5/agent/hello", timeout=15,
                    json={"account": {k: a[k] for k in ("login", "server", "company", "currency", "demo", "leverage", "margin_mode")},
                          "limits": {"max_volume": CFG["max_volume"], "max_positions": CFG["max_positions"],
                                     "allowed_symbols": CFG["allowed_symbols"]},
                          "version": VERSION, "host": socket.gethostname()})
            if r.status_code == 401:
                log("Невалиден токен — провери mt5-agent.config.json")
                time.sleep(15)
                continue
            r.raise_for_status()
            log("Свързан със сайта:", CFG["server_url"])
            backoff = 2
            while True:
                r = api("GET", "/api/mt5/agent/poll", timeout=45)
                if r.status_code == 401:
                    raise RuntimeError("токенът е отхвърлен")
                r.raise_for_status()
                for c in r.json().get("commands", []):
                    run_command(c)
        except KeyboardInterrupt:
            break
        except Exception as e:
            log("Връзката прекъсна:", e, "— нов опит след %ds" % backoff)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            try:
                ensure_mt5()
                a = account_dict() or a
            except Exception:
                traceback.print_exc()
    mt5.shutdown()


if __name__ == "__main__":
    main()
