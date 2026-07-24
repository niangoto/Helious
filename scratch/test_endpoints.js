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
    console.log("Testing /binance?symbol=BTCUSDT&interval=5m&limit=10...");
    const res1 = await testEndpoint("http://localhost:3001/binance?symbol=BTCUSDT&interval=5m&limit=10");
    console.log("Status:", res1.statusCode);
    const parsed = JSON.parse(res1.body);
    console.log("Returned array size:", Array.isArray(parsed) ? parsed.length : "Not an array");
    console.log("First element:", parsed[0]);

    console.log("\nTesting /ticker?symbol=BTCUSDT...");
    const res2 = await testEndpoint("http://localhost:3001/ticker?symbol=BTCUSDT");
    console.log("Status:", res2.statusCode);
    const parsed2 = JSON.parse(res2.body);
    console.log("Price change percent:", parsed2.priceChangePercent);

    console.log("\nTesting static index.html...");
    const res3 = await testEndpoint("http://localhost:3001/");
    console.log("Status:", res3.statusCode);
    console.log("Content-Type:", res3.headers['content-type']);
    console.log("Index length:", res3.body.length);

    console.log("\nAll endpoints tested successfully!");
  } catch (e) {
    console.error("Test failed:", e);
  }
}

run();
