import redis from 'redis';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { promisify } from 'util';
import BigNumber from 'bignumber.js';
import Bluebird from 'bluebird';

BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_DOWN });

import { Monitoring, MonitoringData } from './Monitoring';
import { Relayer, RelayData } from './Relayer';

const ETH_CHAIN_ID = process.env.ETH_CHAIN_ID as string;

// skip chain-id prefix for mainnet
const REDIS_PREFIX = 'eth_shuttle' + ETH_CHAIN_ID.replace('mainnet', '');
const KEY_LAST_HEIGHT = 'last_height';
const KEY_NEXT_SEQUENCE = 'next_sequence';
const KEY_QUEUE_TX = 'queue_tx';

const REDIS_URL = process.env.REDIS_URL as string;
const ETH_BLOCK_SECOND = parseInt(process.env.ETH_BLOCK_SECOND as string);
const ETH_BLOCK_LOAD_UNIT = parseInt(process.env.ETH_BLOCK_LOAD_UNIT as string);

const SLACK_NOTI_NETWORK = process.env.SLACK_NOTI_NETWORK;
const SLACK_NOTI_ETH_ASSET = process.env.SLACK_NOTI_ETH_ASSET;
const SLACK_WEB_HOOK = process.env.SLACK_WEB_HOOK;

const ax = axios.create({
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
  timeout: 15000,
});

class Shuttle {
  monitoring: Monitoring;
  relayer: Relayer;
  getAsync: (key: string) => Promise<string | null>;
  setAsync: (key: string, val: string) => Promise<unknown>;
  llenAsync: (key: string) => Promise<number>;
  lsetAsync: (key: string, index: number, val: string) => Promise<unknown>;
  lrangeAsync: (
    key: string,
    start: number,
    stop: number
  ) => Promise<string[] | undefined>;
  lremAsync: (
    key: string,
    count: number,
    val: string
  ) => Promise<number | undefined>;
  rpushAsync: (key: string, value: string) => Promise<unknown>;

  sequence: number;

  constructor() {
    // Redis setup
    const redisClient = redis.createClient(REDIS_URL, { prefix: REDIS_PREFIX });

    this.getAsync = promisify(redisClient.get).bind(redisClient);
    this.setAsync = promisify(redisClient.set).bind(redisClient);
    this.llenAsync = promisify(redisClient.llen).bind(redisClient);
    this.lsetAsync = promisify(redisClient.lset).bind(redisClient);
    this.lrangeAsync = promisify(redisClient.lrange).bind(redisClient);
    this.lremAsync = promisify(redisClient.lrem).bind(redisClient);
    this.rpushAsync = promisify(redisClient.rpush).bind(redisClient);

    this.monitoring = new Monitoring();
    this.relayer = new Relayer();
    this.sequence = 0;
  }

  async startMonitoring() {
    const sequence = await this.getAsync(KEY_NEXT_SEQUENCE);
    if (sequence && sequence !== '') {
      this.sequence = parseInt(sequence);
    } else {
      this.sequence = await this.relayer.loadSequence();
    }

    // Graceful shutdown
    let shutdown = false;

    const gracefulShutdown = () => {
      shutdown = true;
    };

    process.once('SIGINT', gracefulShutdown);
    process.once('SIGTERM', gracefulShutdown);

    while (!shutdown) {
      await this.process().catch(async (err) => {
        const errorMsg =
          err instanceof Error ? err.toString() : JSON.stringify(err);
        console.error(`Process failed: ${errorMsg}`);

        // ignore invalid project id error
        if (errorMsg.includes('invalid project id')) {
          return;
        }

        // notify to slack
        if (SLACK_WEB_HOOK !== undefined && SLACK_WEB_HOOK !== '') {
          await ax
            .post(SLACK_WEB_HOOK, {
              text: `[${SLACK_NOTI_NETWORK}] Problem Happened: ${errorMsg} '<!channel>'`,
            })
            .catch(() => {
              console.error('Slack Notification Error');
            });
        }

        // sleep 60s after error
        await Bluebird.delay(60 * 1000);
      });

      await Bluebird.delay(500);
    }

    console.info('##### Graceful Shutdown #####');
    process.exit(0);
  }

  async process() {
    // Check whether tx is successfully broadcasted or not
    // If a tx is not found in a block for a long period,
    // rebroadcast the tx with same sequence.
    await this.checkTxQueue();

    const lastHeight = parseInt((await this.getAsync(KEY_LAST_HEIGHT)) || '0');
    const [newLastHeight, monitoringDatas] = await this.monitoring.load(
      lastHeight
    );

    // Relay to terra chain
    if (monitoringDatas.length > 0) {
      const relayData = await this.relayer.build(
        monitoringDatas,
        this.sequence
      );

      if (relayData !== null) {
        // Increase sequence number, only when tx is broadcasted
        this.sequence++;

        await this.rpushAsync(KEY_QUEUE_TX, JSON.stringify(relayData));
        await this.setAsync(KEY_NEXT_SEQUENCE, this.sequence.toString());
        await this.setAsync(KEY_LAST_HEIGHT, newLastHeight.toString());

        // Notify to slack
        if (SLACK_WEB_HOOK !== undefined && SLACK_WEB_HOOK !== '') {
          await ax
            .post(
              SLACK_WEB_HOOK,
              this.buildSlackNotification(monitoringDatas, relayData.txHash)
            )
            .catch(() => {
              console.error('Slack Notification Error');
            });
        }

        console.info(`Relay Success: ${relayData.txHash}`);

        // Do logging first and relay later
        await this.relayer.relay(relayData.tx);
      } else await this.setAsync(KEY_LAST_HEIGHT, newLastHeight.toString());
    } else await this.setAsync(KEY_LAST_HEIGHT, newLastHeight.toString());

    // When catched the block height, wait 10 second
    if (newLastHeight === lastHeight) {
      await Bluebird.delay((ETH_BLOCK_SECOND * ETH_BLOCK_LOAD_UNIT * 1000) / 2);
    }
  }

  async checkTxQueue() {
    await this.lremAsync(KEY_QUEUE_TX, 10, 'DELETE');

    const now = new Date().getTime();
    const len = await this.llenAsync(KEY_QUEUE_TX);

    if (len === 0) {
      return;
    }

    const relayDatas =
      (await this.lrangeAsync(KEY_QUEUE_TX, 0, Math.min(10, len))) || [];

    await Bluebird.mapSeries(relayDatas, async (data, idx) => {
      const relayData: RelayData = JSON.parse(data);
      const tx = await this.relayer.getTransaction(relayData.txHash);

      if (tx === null) {
        if (now - relayData.createdAt > 1000 * 60) {
          // tx not found in the block for a minute,
          await this.relayer.relay(relayData.tx);
        }
      } else {
        // tx found in a block, remove it
        await this.lsetAsync(KEY_QUEUE_TX, idx, 'DELETE');
      }
    });

    await this.lremAsync(KEY_QUEUE_TX, 10, 'DELETE');
  }

  buildSlackNotification(
    monitoringDatas: MonitoringData[],
    resultTxHash: string
  ): { text: string } {
    let notification = '';
    monitoringDatas.forEach((data) => {
      notification += '```';
      notification += `[${SLACK_NOTI_NETWORK}] ${SLACK_NOTI_ETH_ASSET} => TERRA\n`;
      notification += `Sender: ${data.sender}\n`;
      notification += `To:     ${data.to}\n`;
      notification += `\n`;
      notification += `Requested: ${new BigNumber(data.requested)
        .div(1e18)
        .toFixed(6)} ${data.asset}\n`;
      notification += `Amount:    ${new BigNumber(data.amount)
        .div(1e18)
        .toFixed(6)} ${data.asset}\n`;
      notification += `Fee:       ${new BigNumber(data.fee)
        .div(1e18)
        .toFixed(6)} ${data.asset}\n`;
      notification += `\n`;
      notification += `${SLACK_NOTI_ETH_ASSET} TxHash:   ${data.txHash}\n`;
      notification += `Terra TxHash: ${resultTxHash}\n`;
      notification += '```\n';
    });

    const text = `${notification}`;

    return {
      text,
    };
  }
}

export = Shuttle;
