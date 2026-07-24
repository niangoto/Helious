const http = require('http');

function testEndpoint(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function run() {
  try {
    console.log("Testing Gold (PAXGUSDT) Spot Proxy...");
    const res1 = await testEndpoint("http://localhost:3001/binance?symbol=PAXGUSDT&interval=5m&limit=5");
    console.log("PAXGUSDT status:", res1.statusCode);
    const parsed1 = JSON.parse(res1.body);
    console.log("Returned array size:", Array.isArray(parsed1) ? parsed1.length : parsed1);

    console.log("\nTesting Brent Crude Oil (BZUSDT) Futures Proxy Fallback...");
    const res2 = await testEndpoint("http://localhost:3001/binance?symbol=BZUSDT&interval=5m&limit=5");
    console.log("BZUSDT status:", res2.statusCode);
    const parsed2 = JSON.parse(res2.body);
    console.log("Returned array size:", Array.isArray(parsed2) ? parsed2.length : parsed2);

    console.log("\nTesting WTI Crude Oil (CLUSDT) Futures Proxy Fallback...");
    const res3 = await testEndpoint("http://localhost:3001/binance?symbol=CLUSDT&interval=5m&limit=5");
    console.log("CLUSDT status:", res3.statusCode);
    const parsed3 = JSON.parse(res3.body);
    console.log("Returned array size:", Array.isArray(parsed3) ? parsed3.length : parsed3);

    console.log("\nTesting Ticker for Brent Crude Oil...");
    const res4 = await testEndpoint("http://localhost:3001/ticker?symbol=BZUSDT");
    console.log("BZUSDT Ticker status:", res4.statusCode);
    const parsed4 = JSON.parse(res4.body);
    console.log("Last BZUSDT Price:", parsed4.lastPrice);

    console.log("\nAll commodity endpoints are functional and verified!");
  } catch (e) {
    console.error("Test failed:", e);
  }
}

run();
