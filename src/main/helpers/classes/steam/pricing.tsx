import { getValue, setValue } from './settings';
import fs = require('fs');
import path = require('path');

import axios from 'axios';

const EventEmitter = require('events');
class MyEmitter extends EventEmitter {}
const pricingEmitter = new MyEmitter();

let currencyCodes = {
  1: 'USD',
  2: 'GBP',
  3: 'EUR',
  4: 'CHF',
  5: 'RUB',
  6: 'PLN',
  7: 'BRL',
  8: 'JPY',
  9: 'NOK',
  10: 'IDR',
  11: 'MYR',
  12: 'PHP',
  13: 'SGD',
  14: 'THB',
  15: 'VND',
  16: 'KRW',
  17: 'TRY',
  18: 'UAH',
  19: 'MXN',
  20: 'CAD',
  21: 'AUD',
  22: 'NZD',
  23: 'CNY',
  24: 'INR',
  25: 'CLP',
  26: 'PEN',
  27: 'COP',
  28: 'ZAR',
  29: 'HKD',
  30: 'TWD',
  31: 'SAR',
  32: 'AED',
  33: 'SEK',
  34: 'ARS',
  35: 'ILS',
  36: 'BYN',
  37: 'KZT',
  38: 'KWD',
  39: 'QAR',
  40: 'CRC',
  41: 'UYU',
  42: 'BGN',
  43: 'HRK',
  44: 'CZK',
  45: 'DKK',
  46: 'HUF',
  47: 'RON',
};

// Ensure backup directory exists relative to this file
const backupDir = path.join(__dirname, 'backup');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// RUN PROGRAMS
class runItems {
  steamUser;
  seenItems;
  packageToSend;
  header;
  currency;
  headers;
  prices;

  constructor(steamUser) {
    this.steamUser = steamUser;
    this.seenItems = {};
    this.packageToSend = {};
    // Load backup prices if file exists
    const pricesPath = path.join(backupDir, 'prices.json');
    try {
      if (fs.existsSync(pricesPath)) {
        this.prices = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
        console.log('Loaded prices from backup');
      } else {
        this.prices = {};
      }
    } catch (err) {
      console.error('Error loading prices backup:', err);
      this.prices = {};
    }
    getValue('pricing.currency').then((returnValue) => {
      if (returnValue == undefined) {
        setValue('pricing.currency', currencyCodes[steamUser.wallet.currency]);
      }
    });
  }
  async setPricing(pricingData, commandFrom) {
    console.log('pricingSet', commandFrom);
    this.prices = pricingData;
  }
  async makeSinglerequest(itemRow) {
    let itemNamePricing = itemRow.item_name.replaceAll(
      '(Holo/Foil)',
      '(Holo-Foil)'
    );
    if (itemRow.item_wear_name !== undefined) {
      itemNamePricing = itemRow.item_name + ' (' + itemRow.item_wear_name + ')';
      if (!this.prices[itemNamePricing] && this.prices[itemRow.item_name]) {
        itemNamePricing = itemRow.item_name;
      }
    }

    // Get currency code from store (e.g., 1 for USD)
    let currencyCode: number = 1; // Default USD
    await getValue('pricing.currency').then((returnValue) => {
      // Find key by value in currencyCodes
      const foundKey = Object.keys(currencyCodes).find(key => currencyCodes[key] === returnValue);
      currencyCode = foundKey ? parseInt(foundKey, 10) : 1;
    });

    // Query Steam Market API
    const encodedName = encodeURIComponent(itemNamePricing);
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=${currencyCode}&market_hash_name=${encodedName}`;
    try {
      const response = await axios.get(url);
      const data = response.data;
      console.log('Fetched for', itemNamePricing, ':', data);  // Debug log
      if (data.success) {
        // Clean prices (e.g., "€1,23" -> 1.23, handle comma as decimal)
        const cleanPrice = (str) => {
          if (!str) return 0;
          // Remove currency symbol and spaces
          str = str.replace(/[^\d.,-]/g, '').trim();
          // Replace thousand '.' with '', decimal ',' to '.'
          if (str.includes(',') && str.includes('.')) {
            str = str.replace(/\./g, '').replace(',', '.');
          } else if (str.includes(',')) {
            str = str.replace(',', '.');
          }
          return parseFloat(str) || 0;
        };
        let pricingDict = {
          steam_listing: cleanPrice(data.lowest_price) || cleanPrice(data.median_price) || 0,
        };
        // Fallback if no listing (e.g., rare items)
        if (pricingDict.steam_listing === 0 && data.volume > 0) {
          pricingDict.steam_listing = cleanPrice(data.lowest_price) * 0.8 || 0;
        }
        // Update global prices dict for backup with timestamp
        this.prices[itemNamePricing] = {
          steam: {
            last_90d: pricingDict.steam_listing // Simplified; add more fields if needed
          },
          timestamp: Date.now() // Add timestamp for freshness check
        };
        itemRow['pricing'] = pricingDict;
        return itemRow;
      } else {
        throw new Error('API failure');
      }
    } catch (error: any) { // Type as any to access .message
      console.log('Steam API error for', itemNamePricing, ':', error.message);
      let pricingDict = {
        steam_listing: 0,
      };
      itemRow['pricing'] = pricingDict;
      return itemRow;
    }
  }

  private async processPricing(itemRow) {
    let returnRows = [] as any;
    const uniques = new Map(); // Dedupe items
    itemRow.forEach((element) => {
      if (element.item_name !== undefined && element.item_moveable == true) {
        const key = `${element.item_name}_${element.item_wear_name || ''}`; // Unique key
        uniques.set(key, element);
      }
    });

    // Check cache first (from Electron store)
    let cachedPrices = await getValue('pricing.cache') || {};

    const toQuery: any[] = []; // Explicit type to fix never[] inference
    Array.from(uniques.values()).forEach(el => {
      let itemNamePricing = el.item_name.replaceAll(
        '(Holo/Foil)',
        '(Holo-Foil)'
      );
      if (el.item_wear_name !== undefined) {
        itemNamePricing = el.item_name + ' (' + el.item_wear_name + ')';
        if (!this.prices[itemNamePricing] && this.prices[el.item_name]) {
          itemNamePricing = el.item_name;
        }
      }
      const cached = this.prices[itemNamePricing];
      if (cached && cached.timestamp && (Date.now() - cached.timestamp) < 86400000) { // 1 day in ms
        // Use fresh-enough backup
        cachedPrices[itemNamePricing] = {
          steam_listing: cached.steam?.last_90d || 0,
        };
        console.log('Used backup for', itemNamePricing);
      } else {
        toQuery.push(el); // Refetch if old or missing
      }
    });

    // Queue for batching: 3 concurrent, 5s throttle (adjust for ~12/min to avoid 429)
    const { default: PQueue } = await import('p-queue'); // Dynamic import to fix ESM error
    const queue = new PQueue({ concurrency: 3, interval: 5000, intervalCap: 1 });
    const promises = toQuery.map(el => queue.add(async () => {
      const priced = await this.makeSinglerequest(el);
      // Cache result
      let itemNamePricing = priced.item_name.replaceAll(
        '(Holo/Foil)',
        '(Holo-Foil)'
      );
      if (priced.item_wear_name !== undefined) {
        itemNamePricing = priced.item_name + ' (' + priced.item_wear_name + ')';
        if (!this.prices[itemNamePricing] && this.prices[priced.item_name]) {
          itemNamePricing = priced.item_name;
        }
      }
      cachedPrices[itemNamePricing] = priced.pricing;
      await setValue('pricing.cache', cachedPrices);
      return priced;
    }));

    await Promise.all(promises);

    // Apply prices to all (including duplicates)
    itemRow.forEach((el) => {
      if (el.item_name !== undefined && el.item_moveable == true) {
        let itemNamePricing = el.item_name.replaceAll(
          '(Holo/Foil)',
          '(Holo-Foil)'
        );
        if (el.item_wear_name !== undefined) {
          itemNamePricing = el.item_name + ' (' + el.item_wear_name + ')';
          if (!this.prices[itemNamePricing] && this.prices[el.item_name]) {
            itemNamePricing = el.item_name;
          }
        }
        const cached = cachedPrices[itemNamePricing] || { steam_listing: 0 };
        el['pricing'] = cached;
        returnRows.push(el);
      }
    });

    // Save updated prices to backup file (matches existing JSON structure)
    const pricesPath = path.join(backupDir, 'prices.json');
    try {
      fs.writeFileSync(pricesPath, JSON.stringify(this.prices, null, 2));
      console.log('Saved updated prices to backup');
    } catch (err) {
      console.error('Error saving prices backup:', err);
    }

    pricingEmitter.emit('result', itemRow);
  }

  async handleItem(itemRow) {
    await this.processPricing(itemRow);
  }

  async handleTradeUp(itemRow) {
    await this.processPricing(itemRow);
  }
}
module.exports = {
  runItems,
  pricingEmitter,
  currencyCodes,
};
export { runItems, pricingEmitter, currencyCodes };