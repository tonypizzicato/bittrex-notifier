const crypto = require('crypto');
const axios = require('axios');
const EventEmitter = require('events');
const growl = require('growl');
const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const moment = require('moment');

const server = require('./server');

const store = {
  markets: [],
  values: {},
  minmax: {},
  orders: [],
  history: [],
  balance: {},
  banned: {},
  result: 0,
};

server(store);

const emitter = new EventEmitter();

const API_KEY = argv['k'];
const API_SECRET = argv['s'];
const LOOP_INTERVAL = argv['p'] || 20 * 1000;
const RATE_CHANGE_INTERVALS = [2 * 60 * 1000, 30 * 60 * 1000];

const ORDER_AMOUNT_BTC = argv['a'] || 0.001;

function getHash(string) {
  var hmac = crypto.createHmac('sha512', key);
  hmac.update(string);

  return hmac.digest('binary');
}

function getNonce() {
  return moment().unix();
}

function getPrivateUri(uri, nonce) {
  if (_.isEmpty(API_KEY)) {
    throw new Error('API KEY not provided');
  }

  return `${uri}?apikey=${API_KEY}&nonce='.${nonce}`;
}

function signUri(uri, nonce) {
  if (_.isEmpty(API_SECRET)) {
    throw new Error('API SECRET not provided');
  }

  const hmac = crypto.createHmac('sha512', API_SECRET);
  hmac.update(uri);

  return hmac.digest('hex');
}

function getHeaders(signature) {
  return {
    headers: {
      apisign: signature,
    },
  };
}

function getMarkets() {
  return axios.get('https://bittrex.com/api/v1.1/public/getmarkets').then(response => response.data.result);
}

function getRate(market) {
  const url = `http://bittrex.com/api/v1.1/public/getmarketsummary?market=${market}`;

  return axios.get(url).then(response => response.data.result);
}

function getBalance() {
  const nonce = getNonce();
  const uri = getPrivateUri('https://bittrex.com/api/v1.1/account/getbalances', nonce);
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => response.data.result);
}

function fetchLoop(market) {
  getRate(market)
    .then(raw => emitter.emit('tick', market, raw))
    .catch(err => console.warn('Error:', err.message));

  setTimeout(fetchLoop.bind(null, market), LOOP_INTERVAL);
}

function processTick(market, current) {
  const timestr = _.get(current, '0.TimeStamp');
  const value = _.get(current, '0.Last', 0);

  if (!value || !timestr) {
    return;
  }

  const time = moment(timestr).unix();

  emitter.emit('rate', market, {
    value,
    time,
  });
}

emitter.on('tick', processTick);

// store rates
emitter.on('rate', (market, rate) => {
  _.set(store, `values.${market}`, _.get(store, `values.${market}`, []).concat(rate));
});

// store minmax
emitter.on('rate', (market, rate) => {
  const prev = _.get(store, `minmax.${market}`);

  _.set(store, `minmax.${market}.min`, prev.min.value > rate.value ? rate : prev.min);
  _.set(store, `minmax.${market}.max`, prev.max.value < rate.value ? rate : prev.max);

  emitter.emit('minmax', market);
});

// check explosive changes
emitter.on('rate', (market, rate) => {
  RATE_CHANGE_INTERVALS.forEach(i => {
    const indexshift = Math.round(i / LOOP_INTERVAL);
    const marketValues = store.values[market];

    if (marketValues.length > indexshift) {
      const startValue = marketValues[marketValues.length - indexshift];
      const change = rate.value / startValue.value - 1;

      if (change > 0.08) {
        emitter.emit('explosion', market, rate, change);
      }
    }
  });
});

// check results
emitter.on('rate', (market, rate) => {
  store.orders.filter(o => o.market === market).forEach(order => {
    const change = rate.value / order.rate.value - 1;

    // check if we need to buy and take profit or sell and stop loss
    if (change > 0.12 || change < -0.05) {
      // remove order from active orders and add to history
      store.history.concat(_.remove(store.orders, o => o.market === market));

      emitter.emit('result', market, rate, order, change);
    }
  });
});

// buy on explosive market
emitter.on('explosion', (market, rate, change) => {
  console.log('Explosive change on', market, '. Change:', change);

  if (!store.orders.some(o => o.market === market) && !store.banned[market]) {
    store.orders.push({ market, rate });
  }
});

// check maximum growth overall
emitter.on('minmax', market => {
  const minmax = store.minmax[market];

  if (minmax.max / minmax.min - 1 > 0.2) {
    emitter.emit('total-growth', market, rate, minmax.max / minmax.min - 1);
  }
});

// update results
emitter.on('result', (market, rate, order, change) => {
  const old = store.result;
  store.result += change;

  if (change < 0) {
    _.set(state, `banned.${market}`, { ...order.rate.time });
  }

  console.log('==========================');
  console.log('Result changed.', market);
  console.log('Buy rate:', order.rate.value.toFixed(8), '. Sell rate:', rate.value.toFixed(8));
  console.log('Spent BTC:', ORDER_AMOUNT_BTC, '. Buy amount:', (ORDER_AMOUNT_BTC / order.rate.value).toFixed(4));
  console.log('Received BTC:', (ORDER_AMOUNT_BTC / order.rate.value * rate.value).toFixed(4));
  console.log('Prev result:', old.toFixed(8), '. New value:', store.result.toFixed(8));
  console.log('==========================');
});

emitter.on('total-growth', (market, rate, change) => {
  growl(`${market} ${change.toFixed(2)}% growth`, {
    group: 'bittrex',
    title: 'Bittrex',
    subtitle: 'Growth found',
    image: 'logo.png',
    url: `https://bittrex.com/Market/Index?MarketName=${market}`,
    sound: 'default',
  });
});

// emitter.on('explosion', (market, rate, change) => {
//   growl(`Explosive growth of ${market}!!!`, {
//     group: 'bittrex',
//     title: 'Bittrex',
//     subtitle: `Explosive growth found - ${change.toFixed(2)}%`,
//     image: 'logo.png',
//     url: `https://bittrex.com/Market/Index?MarketName=${market}`,
//     sound: 'default',
//   });
// });

emitter.on('result', (market, rate, order, change) => {
  growl(`Order: ${change.toFixed(2)}% on ${market}`, {
    name: 'bittrex-notifier',
    group: 'bittrex',
    title: 'Bittrex',
    image: 'logo.png',
    url: `https://bittrex.com/Market/Index?MarketName=${market}`,
    sound: 'default',
  });
});

const minmaxdefault = { min: { value: Number.MAX_SAFE_INTEGER, time: 0 }, max: { value: 0, time: 0 } };

getBalance()
  .then(balances => balances.filter(m => !!m.Balance))
  .then(balances => {
    balances.forEach(b => {
      _.set(store, `balance.${b.Currency}`, b.Balance);
    });

    return balances;
  })
  .catch(err => console.warn('Error:', err.message));

// get market tickers
const markets = getMarkets();

markets
  .then(markets => markets.filter(m => m.BaseCurrency === 'BTC'))
  .then(markets => markets.map(m => m.MarketName))
  .then(markets => {
    _.set(store, 'markets', markets);

    return markets;
  })
  .then(markets => {
    _.set(store, 'minmax', markets.reduce((res, m) => _.set(res, m, { ...minmaxdefault }), {}));

    return markets;
  })
  .then(markets => {
    markets.forEach(m => fetchLoop(m));

    return markets;
  })
  .catch(err => console.warn('Error:', err.message));

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
