import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('Error: REDIS_URL is not defined in the environment variables.');
  process.exit(1);
}

console.log('Connecting to Redis...');

const client = createClient({
  url: redisUrl
});

client.on('error', (err) => console.error('Redis Client Error:', err));

async function run() {
  try {
    await client.connect();
    console.log('Successfully connected to Upstash Redis!');

    // Test ping
    const pingResponse = await client.ping();
    console.log('PING response:', pingResponse);

    // Test set & get
    const testKey = 'test_connection_key';
    const testVal = `hello_redis_${Date.now()}`;
    await client.set(testKey, testVal);
    console.log(`Set key "${testKey}" to "${testVal}"`);

    const gotVal = await client.get(testKey);
    console.log(`Got key "${testKey}": "${gotVal}"`);

    // Clean up
    await client.del(testKey);
    console.log(`Deleted key "${testKey}"`);

    await client.disconnect();
    console.log('Disconnected from Redis successfully.');
  } catch (error) {
    console.error('Failed to run Redis test:', error);
  }
}

run();
