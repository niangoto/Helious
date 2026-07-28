#!/usr/bin/env python3
"""
MT5 Bridge — свързва Node.js с MetaTrader 5.
Използване:
  python3 mt5-bridge.py --check           # проверка дали MT5 е наличен
  python3 mt5-bridge.py --symbol EURUSD --timeframe H1 --bars 500  # извличане на данни

Изисква: pip install MetaTrader5
"""

import sys
import json
import argparse

def check_mt5():
    """Проверка дали MT5 е наличен"""
    try:
        import MetaTrader5 as mt5
        initialized = mt5.initialize()
        if initialized:
            mt5.shutdown()
            print("ok")
            return True
        print("not_initialized")
        return False
    except ImportError:
        print("not_installed")
        return False
    except Exception as e:
        print(f"error: {e}")
        return False


def fetch_data(symbol, timeframe_str, bars=500):
    """Извличане на исторически данни от MT5"""
    TIMEFRAMES = {
        'M1': 1, 'M5': 5, 'M15': 15, 'M30': 30,
        'H1': 60, 'H4': 240, 'D1': 1440, 'W1': 10080, 'MN1': 43200
    }

    tf = TIMEFRAMES.get(timeframe_str.upper())
    if tf is None:
        print(json.dumps({"error": f"Invalid timeframe: {timeframe_str}"}))
        return

    import MetaTrader5 as mt5

    if not mt5.initialize():
        print(json.dumps({"error": "MT5 initialization failed"}))
        return

    # Проверка дали символът съществува
    all_symbols = [s.name for s in mt5.symbols_get()]
    found = [s for s in all_symbols if symbol.upper() in s.upper()]

    if not found:
        mt5.shutdown()
        print(json.dumps({"error": f"Symbol {symbol} not found", "available": all_symbols[:20]}))
        return

    # Използвай най-точния match
    target = symbol.upper()
    exact = [s for s in found if s.upper() == target]
    if exact:
        target = exact[0]
    else:
        target = found[0]

    mt5.symbol_select(target, True)
    rates = mt5.copy_rates_from_pos(target, tf, 0, bars)

    mt5.shutdown()

    if rates is None or len(rates) == 0:
        print(json.dumps({"error": f"No data for {target}"}))
        return

    candles = []
    for r in rates:
        candles.append({
            "time": r[0],
            "open": float(r[1]),
            "high": float(r[2]),
            "low": float(r[3]),
            "close": float(r[4]),
            "volume": int(r[5])
        })

    print(json.dumps(candles))


def main():
    parser = argparse.ArgumentParser(description='MT5 Data Bridge')
    parser.add_argument('--check', action='store_true', help='Check MT5 availability')
    parser.add_argument('--symbol', type=str, help='Trading symbol (e.g. EURUSD)')
    parser.add_argument('--timeframe', type=str, default='D1', help='Timeframe: M1, M5, M15, M30, H1, H4, D1, W1, MN1')
    parser.add_argument('--bars', type=int, default=500, help='Number of bars to fetch')

    args = parser.parse_args()

    if args.check:
        check_mt5()
    elif args.symbol:
        fetch_data(args.symbol, args.timeframe, args.bars)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
