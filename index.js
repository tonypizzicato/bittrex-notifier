const axios = require('axios');
const growl = require('growl');
const argv = require('minimist')(process.argv.slice(2));

let last = 0;

function getRate(market) {
  const url = `http://bittrex.com/api/v1.1/public/getticker?market=${market}`;

  return axios.get(url).then(response => response.data.result.Last);
}

function fetch(market, diff, cb) {
  getRate(market)
    .then(cb.bind(null, market, diff))
    .catch(error => console.warn(error));

  setTimeout(fetch.bind(null, market, diff, cb), 10 * 1000);
}

function updateLastValue(market, diff, current) {
  if (last && (current > last + diff || current < last - diff)) {
    const currentStr = parseFloat(current).toFixed(2);
    const lastStr = parseFloat(last).toFixed(2);
    const emoji = current > last ? ':)' : ':(';
    
    growl(`${currentStr} vs ${lastStr} ${emoji}`, {
      group: 'bittrex',
      title: 'Bittrex',
      subtitle: 'Price changed',
      image: 'logo.png',
      url: `https://bittrex.com/Market/Index?MarketName=${market}`,
      sound: 'default',
    });
  }
  last = current;
}

const market = argv['m'] || 'USDT-BTC';
const diff = argv['d'] || 10;

fetch(market, diff, updateLastValue);
