const crypto = require('crypto');
const axios = require('axios');
const EventEmitter = require('events');
const growl = require('growl');
const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const moment = require('moment');
const WebSocket = require('ws');
const bittrex = require('./node.bittrex.api');

const signalR = require('signalr-client');

const websockets_baseurl = 'wss://socket.bittrex.com/signalr';
const websockets_hubs = ['CoreHub'];

const server = require('./server');

const store = {
  markets: [],
  values: {},
  minmax: {},
  orders: [],
  history: [],
  balance: {},
  banned: {
    'BTC-RDD': {
      count: Number.MAX_SAFE_INTEGER,
      market: 'BTC-RDD',
      rate: {
        value: 9e-8,
        time: 1513072524,
      },
    },
    'BTC-DOGE': {
      count: Number.MAX_SAFE_INTEGER,
      market: 'BTC-DOGE',
      rate: {
        value: 9e-8,
        time: 1513072524,
      },
    },
  },
  rising: {},
  result: 0,
  active: true,
  balancechange: 0,
};

server(store);

const emitter = new EventEmitter();

// if to send real orders
const REAL_ORDERS = argv['r'];

const API_KEY = argv['k'];
const API_SECRET = argv['s'];
const RATES_POLL_INTERVAL = argv['p'] || 10 * 1000;
const RATE_CHANGE_INTERVALS = [
  // 2 * 60 * 1000, maybe 2 minutes give not interesting result for me
  1 * 60 * 1000,
  // 10 * 60 * 1000,
  15 * 60 * 1000,
  // 20 * 60 * 1000,
  30 * 60 * 1000,
];
// poll orders rates every 5 seconds;
const ORDER_POLL_INTERVAL = 5 * 1000;

const ORDER_AMOUNT_BTC = argv['a'] || 0.001;

// percents between current and previous values
const BUY_GROWTH_THRESHOLD = 0.08;
const RISING_THRESHOLD = 0.07; // 0.07
const SELL_GROWTH_THRESHOLD = 0.01;
const SELL_FALL_THRESHOLD = -1;

const NOT_FOR_TRADE = ['ETH', 'MONA', 'MANA', 'ADT', 'BSD', 'VOX'];

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

  return axios.get(url).then(response => ({
    value: response.data.result.Last,
    market: response.data.result.MarketName,
    time: response.data.result.TimeStamp,
  }));
}

function buylimit(market, rate) {
  const amount = 0.0005 / rate;
  console.log(`Trying to BUY ${amount} ${market.substring(4)} for ${rate} per item. Total BID: ${amount * rate}`);

  if (!REAL_ORDERS) {
    return Promise.resolve({ uuid: 'fakeid' });
  }

  const nonce = getNonce();
  const uri = getPrivateUri(
    `https://bittrex.com/api/v1.1/market/buylimit?market=${market}&quantity=${amount}&rate=${rate}`,
    nonce
  );
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => {
    console.log(response.data);

    return response.data.result;
  });
}

function selllimit(market, rate) {
  const amount = _.get(store.balance, market.substring(4), 0);

  console.log(`Trying to SELL ${amount} ${market.substring(4)} for ${rate} per item. Total ASK: ${amount * rate}`);

  if (!REAL_ORDERS) {
    return Promise.resolve({ uuid: 'fakeid' });
  }

  const nonce = getNonce();
  const uri = getPrivateUri(
    `https://bittrex.com/api/v1.1/market/selllimit?market=${market}&quantity=${amount}&rate=${rate}`,
    nonce
  );
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => {
    console.log(response.data);

    return response.data.result;
  });
}

function getRates(market) {
  const url = `http://bittrex.com/api/v1.1/public/getmarketsummaries`;

  return axios.get(url).then(response =>
    response.data.result.filter(m => m.MarketName.indexOf('BTC-') === 0).map(m => ({
      value: m.Last,
      market: m.MarketName,
      time: m.TimeStamp,
    }))
  );
}

function getBalance() {
  const nonce = getNonce();
  const uri = getPrivateUri('https://bittrex.com/api/v1.1/account/getbalances', nonce);
  const signature = signUri(uri, nonce);

  return axios.get(uri, getHeaders(signature)).then(response => response.data.result);
}

wsclient = new signalR.client(websockets_baseurl, websockets_hubs, undefined, true);

bittrex.websockets.listen(function(data, client) {
  if (data.M === 'updateSummaryState') {
    data.A.forEach(data => {
      data.Deltas.filter(m => m.MarketName.indexOf('BTC-') === 0).forEach(m => {
        emitter.emit('rate', m.MarketName, {
          value: m.Last,
          bid: m.Bid,
          ask: m.Ask,
          time: moment(m.TimeStamp).unix(),
        });
      });
    });
  }
});

function fetchLoop() {
  getRates()
    .then(markets => emitter.emit('tick', markets))
    .catch(err => console.warn('Error:', err.message));

  setTimeout(fetchLoop, RATES_POLL_INTERVAL);
}

function fetchOrderedLoop(market) {
  getRate(market)
    .then(tick => emitter.emit('tick', [tick]))
    .catch(err => console.warn('Error:', err.message));

  if (store.orders.some(o => o.market === market)) {
    setTimeout(fetchOrderedLoop.bind(null, market), ORDER_POLL_INTERVAL);
  }
}

function processTick(ticks) {
  ticks.forEach(m => {
    const time = moment(m.time).unix();

    emitter.emit('rate', m.market, {
      value: m.value,
      time,
    });
  });
}

emitter.on('tick', processTick);

// store rates
emitter.on('rate', (market, rate) => {
  _.set(store, `values.${market}`, _.get(store, `values.${market}`, []).concat(rate));
});

// store minmax
emitter.on('rate', (market, rate) => {
  const prev = _.get(store, `minmax.${market}`, {
    ...minmaxdefault,
  });

  _.set(store, `minmax.${market}.min`, prev.min.value > rate.value ? rate : prev.min);
  _.set(store, `minmax.${market}.max`, prev.max.value < rate.value ? rate : prev.max);

  emitter.emit('minmax', market);
});

const BreakException = {};

// check explosive changes
emitter.on('rate', (market, rate) => {
  try {
    RATE_CHANGE_INTERVALS.forEach(i => {
      const indexshift = Math.round(i / RATES_POLL_INTERVAL);
      const marketValues = store.values[market];

      if (marketValues.length > indexshift) {
        const startValue = marketValues[marketValues.length - indexshift];
        const change = rate.value / startValue.value - 1;

        if (change > RISING_THRESHOLD) {
          emitter.emit('explosion', market, rate, change, i);
          throw BreakException;
        }
      }
    });
  } catch (e) {
    if (e !== BreakException) throw e;
  }
});

// check results
emitter.on('rate', (market, rate) => {
  store.orders.filter(o => o.market === market).forEach(order => {
    const change = rate.value / order.rate.value - 1;

    const orderIndex = _.findIndex(store.orders, o => o.market === market);

    _.set(store, `orders.${orderIndex}.change`, change);

    // check if we need to buy and take profit or sell and stop loss
    if (change >= SELL_GROWTH_THRESHOLD || change <= SELL_FALL_THRESHOLD) {
      selllimit(market, rate.value)
        .then(res => {
          console.log('SELL order placed');

          return res;
        })
        .then(res => {
          // remove order from active orders and add to history
          const [order] = _.remove(store.orders, o => o.market === market);

          store.history = store.history.concat([
            {
              market,
              open: order.rate,
              close: rate,
            },
          ]);

          emitter.emit('result', market, rate, order, change);
        });
    }
  });
});

// buy on explosive market
emitter.on('explosion', (market, rate, change, i) => {
  const banned = store.banned[market] && store.banned[market].count > 2;

  console.log(
    'Explosive change in',
    i / 60 / 1000,
    'min on',
    market,
    '. Change:',
    change,
    banned ? '[BANNED]' : '',
    moment().format()
  );

  if (store.active && !store.orders.some(o => o.market === market) && !banned) {
    if (NOT_FOR_TRADE.indexOf(market.substring(4)) > -1) {
      console.warn(`${market} is not for trading!`);

      return;
    }

    _.set(store.rising, market, {
      count: _.get(store.rising, `${market}.count`, 0) + 1,
      change: _.get(store.rising, `${market}.change`, 0) + change,
    });

    if (_.get(store.rising, `${market}.count`) >= 1) {
      buylimit(market, rate.value)
        .then(res => {
          console.log('BUY order placed');

          return res;
        })
        .then(res => {
          updateBalances();

          _.defer(() =>
            store.orders.push({
              market,
              rate,
              change: 0,
              amount: 0.00001,
              id: res.uuid,
            })
          );
        })
        .catch(err => console.warn(`BUY err: ${err.message}`));
    }
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
    _.set(store, banned, market, {
      ...order,
      count: _.get(store.banned, `${market}.count`, 0) + 1,
    });

    _.set(store.rising, market, {
      ...rate,
      count: _.set(store.rising, `${market}.count`, 0) + 1,
    });
  } else {
    _.set(store, `banned.${market}.count`, 0);
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

emitter.on('explosion', (market, rate, change, interval) => {
  if (store.orders.some(o => o.market === market) || store.banned[market]) {
    return;
  }

  growl(`Explosive growth of ${market}!!!`, {
    group: 'bittrex',
    title: 'Bittrex',
    subtitle: `Growth ${change.toFixed(2)}% in ${interval / 60 / 1000}min`,
    image: 'logo.png',
    url: `https://bittrex.com/Market/Index?MarketName=${market}`,
    sound: 'default',
  });
});

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

const minmaxdefault = {
  min: {
    value: Number.MAX_SAFE_INTEGER,
    time: 0,
  },
  max: {
    value: 0,
    time: 0,
  },
};

function updateBalances() {
  return getBalance()
    .then(balances => balances.filter(m => !!m.Balance))
    .then(balances => {
      balances.forEach(b => {
        if (b.Currency === 'BTC' && _.get(store.balance, 'BTC', 0)) {
          store.balancechange += b.Balance - _.get(store.balance, 'BTC', 0);
        }

        _.set(store.balance, b.Currency, b.Balance);
      });

      console.log('Balances updated');

      return balances;
    })
    .catch(err => console.warn('Error:', err.message));
}

updateBalances();

// get market tickers
const markets = getMarkets();

markets
  .then(markets => markets.filter(m => m.BaseCurrency === 'BTC'))
  .then(markets => markets.map(m => m.MarketName))
  .then(markets => {
    _.set(store, 'markets', markets);

    return markets;
  })
  // .then(markets => {
  //   fetchLoop();

  //   return markets;
  // })
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
