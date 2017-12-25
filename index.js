const crypto = require('crypto');
const axios = require('axios');
const EventEmitter = require('events');
const growl = require('growl');
const argv = require('minimist')(process.argv.slice(2));
const _ = require('lodash');
const moment = require('moment-timezone');
const bittrex = require('./node.bittrex.api');

const websockets_baseurl = 'wss://socket.bittrex.com/signalr';
const websockets_hubs = ['CoreHub'];

const server = require('./server');

moment.tz.setDefault('GMT');

const store = {
  markets: [],
  values: {},
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
  result: {
    active: 0,
    finished: 0,
  },
  active: true,
  silent: false,
  balancechange: 0,
};

const emitter = new EventEmitter();

// if to send real orders
const REAL_ORDERS = argv['r'];

const API_KEY = argv['k'];
const API_SECRET = argv['s'];
const PORT = argv['p'];
const ORDER_AMOUNT_BTC = argv['a'] || 0.001;

// percents between current and previous values
const RISING_COUNT_THRESHOLD = 3;
const EXPLOSION_THRESHOLD = 0.01; // 0.07
const SELL_GROWTH_THRESHOLD = 0.02;
const SELL_FALL_THRESHOLD = -1;
const CHECK_RATE_PERIOD_MINUTES = 1;

const NOT_FOR_TRADE = ['ETH', 'MONA', 'MANA', 'BSD', 'VOX'];

const addCustomRoutes = app => {
  app.get('/info', (req, res) => {
    res.json({
      RISING_COUNT_THRESHOLD,
      EXPLOSION_THRESHOLD,
      SELL_GROWTH_THRESHOLD,
      SELL_FALL_THRESHOLD,
      CHECK_RATE_PERIOD_MINUTES,
      NOT_FOR_TRADE,
      REAL_ORDERS,
      comments: '>= 0.1 :: 10 minutes; >= 0.001 :: 30 minutes',
    });
  });
};

const router = server(store, PORT, addCustomRoutes);

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
    return Promise.resolve({
      uuid: 'fakeid',
    });
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
    return Promise.resolve({
      uuid: 'fakeid',
    });
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

// update results
emitter.on('result', (market, rate, order, change) => {
  const old = store.result.finished;

  store.result.finished += change;

  if (change < 0) {
    _.set(store.banned, market, {
      ...order,
      count: _.get(store.banned, `${market}.count`, 0) + 1,
    });

    _.set(store.rising, market, {
      ...rate,
      count: 0,
    });
  } else {
    _.set(store.banned, `${market}.count`, 0);
  }

  console.log('==========================');
  console.log('Result changed.', market);
  console.log('Buy rate:', order.rate.value.toFixed(8), '. Sell rate:', rate.value.toFixed(8));
  console.log('Spent BTC:', ORDER_AMOUNT_BTC, '. Buy amount:', (ORDER_AMOUNT_BTC / order.rate.value).toFixed(4));
  console.log('Received BTC:', (ORDER_AMOUNT_BTC / order.rate.value * rate.value).toFixed(5));
  console.log('Prev result:', old.toFixed(8), '. New value:', store.result.finished.toFixed(8));
  console.log('==========================');
});

emitter.on('result', (market, rate, order, change) => {
  if (store.silent) {
    return;
  }

  growl(`Order: ${change.toFixed(2)}% on ${market}`, {
    name: 'bittrex-notifier',
    group: 'bittrex',
    title: `Bittrex:${PORT}`,
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

    emitter.emit('markets', markets);

    return markets;
  })
  .catch(err => console.warn('Error:', err.message));

bittrex.options({
  websockets: {
    onConnect: function() {
      console.log('Websocket connected');
    },
    onDisconnect: function() {
      console.log('Websocket disconnected');
    },
  },
});

emitter.on('markets', markets => {
  bittrex.websockets.subscribe(markets, data => {
    if (data.M === 'updateExchangeState') {
      data.A.forEach(function(data_for) {
        const market = data_for.MarketName;
        const rates = data_for.Fills.map(f => ({
          value: f.Rate,
          time: moment(f.TimeStamp).unix(),
        }));

        if (rates.length) {
          emitter.emit('rates', market, rates);
        }
      });
    }
  });
});

emitter.on('rates', (market, rates) => {
  const now = moment().unix();
  const newrates = _.get(store.values, market, []).concat(rates);

  const periodStartIndex = _.findLastIndex(newrates, r => now - r.time > CHECK_RATE_PERIOD_MINUTES * 60);

  if (periodStartIndex > 0) {
    const periodRates = newrates.slice(periodStartIndex);

    _.set(store.values, market, newrates.slice(periodStartIndex));

    const getValue = r => r.value;
    const first = _.first(periodRates);
    const last = _.last(periodRates);
    const max = _.maxBy(periodRates, getValue);
    const min = _.minBy(periodRates, getValue);
    const mean = _.meanBy(periodRates, getValue);

    const change = max.value / min.value - 1;
    const half = (max.value - min.value) / 2 + min.value;

    if (max.time > min.time && last.value > first.value) {
      if (change > EXPLOSION_THRESHOLD) {
        emitter.emit('_explosion', market, _.last(rates), change, CHECK_RATE_PERIOD_MINUTES);
      }
    }
  } else {
    _.set(store.values, market, newrates);
  }
});

// buy on explosive market
emitter.on('_explosion', (market, rate, change, period) => {
  const banned = store.banned[market] && store.banned[market].count > 2;

  if (store.active && !store.orders.some(o => o.market === market) && !banned) {
    if (NOT_FOR_TRADE.indexOf(market.substring(4)) > -1) {
      return;
    }

    const rising = _.get(store.rising, market, { count: 0, ...rate });

    if (rising.count < RISING_COUNT_THRESHOLD) {
      const timediff = rate.time - rising.time;

      if ((rising.count == 0 && timediff === 0) || timediff > CHECK_RATE_PERIOD_MINUTES * 60) {
        rising.count && console.log('UPDATE GROWTH:', market, rate.time, rising.time, timediff);

        _.set(store.rising, market, { count: rising.count + 1, ...rate });
      }

      return;
    }

    emitter.emit('buy', market, rate, change, period);

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
});

emitter.on('rates', (market, rates) => {
  store.orders.filter(o => o.market === market).forEach(order => {
    const now = moment().unix();
    const rate = _.last(rates);
    const change = rate.value / order.rate.value - 1;

    const orderIndex = _.findIndex(store.orders, o => o.market === market);

    _.set(store.orders, `${orderIndex}.change`, change);

    if (
      change >= SELL_GROWTH_THRESHOLD ||
      (change >= 0.01 && now - store.orders[orderIndex].rate.time > 10 * 60) ||
      (change >= 0.001 && now - store.orders[orderIndex].rate.time > 30 * 60)
    ) {
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

  store.result.active = store.orders.reduce((acc, o) => (acc += o.change), 0);
});

emitter.on('buy', (market, rate, change, period) => {
  if (store.orders.some(o => o.market === market) || store.banned[market]) {
    return;
  }

  if (store.silent) {
    return;
  }

  growl(`Buy ${market}`, {
    group: 'bittrex',
    title: `Bittrex:${PORT}`,
    subtitle: `Growth ${change.toFixed(2)}% in ${period} minutes`,
    image: 'logo.png',
    url: `https://bittrex.com/Market/Index?MarketName=${market}`,
    sound: 'default',
  });
});
