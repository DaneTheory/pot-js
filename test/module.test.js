import delay from 'delay';
import { exec, Connection } from '../src';
import { Client } from 'promise-ws';

const entry = 'test/fixtures/socket.js';
const PORT = 3010;

let proc;

beforeEach(async () => {
	jest.setTimeout(10000);
});

afterEach(async () => {
	if (proc && typeof proc.kill === 'function') {
		await proc.kill();
		await delay(1000);
	}
});

describe('api module `exec`', () => {
	test('should `entry` and `port` work', async () => {
		proc = await exec({ env: { PORT }, entry });
		await delay(1000);
		const client = await Client.create('ws://127.0.0.1:3010');
		const text = await client.request('test', '掂');
		expect(text).toBe('掂');
	});

	test('should `crashes` work', async () => {
		proc = await exec({
			entry: 'test/fixtures/crash.js',
			maxRestarts: 1,
		});
		await delay(2000);
		const connections = await Connection.getList();
		const state = await connections[0].getState();
		expect(state.monitor.crashes).toBe(2);
	});

	test('should `ENV_VAR_KEY` work', async () => {
		const hello = 'world';
		proc = await exec({
			env: { PORT },
			entry,
			hello,
		});
		await delay(1000);
		const client = await Client.create('ws://127.0.0.1:3010');
		const envString = await client.request('env');
		expect(JSON.parse(envString)).toMatchObject({
			hello,
			entry,
		});
	});
});

describe('api module `Connection.getList()`', () => {
	test('should `getState` work', async () => {
		const name = 'hello';
		proc = await exec({ name, entry });
		await delay(1000);
		const connections = await Connection.getList();
		const state = await connections[0].getState();
		expect(typeof state.pid).toBe('number');
		expect(state.monitor.crashes).toBe(0);
		expect(state.monitor.status).toBe('running');
		expect(state.name).toBe(name);
		expect(state.entry).toBe(entry);
	});

	test('should `setState` work', async () => {
		const name = 'hello';
		proc = await exec({ name, entry });
		await delay(1000);
		{
			const connections = await Connection.getList();
			const state = await connections[0].getState();
			expect(state.name).toBe(name);
			expect(state.hello).toBe(undefined);
		}

		{
			const connections = await Connection.getList();
			const state = await connections[0].setState({ hello: 'world' });
			expect(state.hello).toBe('world');
		}
	});
});
