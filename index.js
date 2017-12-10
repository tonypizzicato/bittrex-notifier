const axios = require('axios');
const growl = require('growl');
const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const moment = require('moment');

const store = {
  markets: [],
  values: {},
};

function getMarkets() {
  return axios.get('https://bittrex.com/api/v1.1/public/getmarkets').then(response => response.data.result);
}
function getRate(market) {
  const url = `http://bittrex.com/api/v1.1/public/getmarketsummary?market=${market}`;

  return axios.get(url).then(response => response.data.result);
}

function fetch(market, diff, cb) {
  getRate(market)
    .then(cb.bind(null, market, diff))
    .catch(error => console.warn(error));

  setTimeout(fetch.bind(null, market, diff, cb), 20 * 1000);
}

function processTick(market, diff, current) {
  const timestr = _.get(current, '0.TimeStamp');
  const value = _.get(current, '0.Last', 0);

  if (!value || !timestr) {
    return;
  }

  const time = moment(timestr).unix();

  _.set(store, `values.${market}`, _.get(store, `values.${market}`, []).concat({ value, time }));
}

const market = argv['m'] || 'USDT-BTC';
const diff = argv['d'] || 10;

// get market tickers
const markets = getMarkets();

markets
  .then(markets => markets.map(m => m.MarketName))
  .then(markets => {
    _.set(store, 'markets', markets);

    return markets;
  })
  .then(markets => {
    markets.forEach(m => fetch(m, diff, processTick));

    return markets;
  })
  .catch(console.log);

// function updateLastValue(market, diff, current) {
//   const lastValue = last[market];

//   if (lastValue && (current > lastValue + diff || current < lastValue - diff)) {
//     const currentStr = parseFloat(current).toFixed(2);
//     const lastStr = parseFloat(lastValue).toFixed(2);
//     const emoji = current > lastValue ? ':)' : ':(';

//     growl(`${currentStr} vs ${lastStr} ${emoji}`, {
//       group: 'bittrex',
//       title: 'Bittrex',
//       subtitle: 'Price changed',
//       image: 'logo.png',
//       url: `https://bittrex.com/Market/Index?MarketName=${market}`,
//       sound: 'default',
//     });
//   }
//   last[market] = current;
// }
