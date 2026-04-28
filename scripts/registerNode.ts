import { Address } from '@ton/core';
import { CocoonRoot } from '../wrappers/CocoonRoot';
import { NetworkProvider } from '@ton/blueprint';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4, TonClient4 } from '@ton/ton';
import { createHash } from 'crypto';

// Seed Blueprint-compatible env vars from CLI args before Blueprint creates its NetworkProvider.
{
    const argv = process.argv;
    for (let i = 2; i < argv.length - 1; i++) {
        if (argv[i] === '--mnemonic')       process.env.WALLET_MNEMONIC = argv[i + 1];
        if (argv[i] === '--wallet-version') process.env.WALLET_VERSION  = argv[i + 1];
        if (argv[i] === '--network' && argv[i + 1] === 'testnet') process.env.NETWORK = 'testnet';
        if (argv[i] === '--network' && argv[i + 1] === 'mainnet') process.env.NETWORK = 'mainnet';
    }
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--') && arg.length > 2) {
            const key = arg.slice(2);
            if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                args[key] = argv[i + 1];
                i++;
            } else {
                args[key] = 'true';
            }
        }
    }
    return args;
}

function fail(error: string): never {
    process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function run(_provider: NetworkProvider) {
    const args = parseArgs(process.argv);

    const op             = args['op'];
    const rootStr        = args['root'];
    const network        = args['network'];
    const mnemonic       = args['mnemonic'];
    const walletVersion  = args['wallet-version'];

    if (!op)            fail('missing --op');
    if (!rootStr)       fail('missing --root');
    if (!network)       fail('missing --network');
    if (!mnemonic)      fail('missing --mnemonic');
    if (!walletVersion) fail('missing --wallet-version');

    if (network !== 'mainnet' && network !== 'testnet') {
        fail('--network must be mainnet or testnet');
    }

    let hashBuf:  Buffer | undefined;
    let valueStr: string | undefined;
    let seqno:    number | undefined;

    switch (op) {
        case 'addWorkerType':
        case 'addProxyType': {
            const h = args['hash'];
            if (!h)              fail('missing --hash');
            if (h.length !== 64) fail('--hash must be 64 hex chars (32 bytes)');
            hashBuf = Buffer.from(h, 'hex');
            break;
        }
        case 'addModelType': {
            const v = args['value'];
            if (!v) fail('missing --value');
            valueStr = v;
            hashBuf  = Buffer.from(createHash('sha256').update(v, 'utf8').digest());
            break;
        }
        case 'addProxyInfo': {
            const v = args['value'];
            if (!v) fail('missing --value');
            valueStr = v;
            if (Buffer.byteLength(v, 'utf8') > 127) {
                fail('--value exceeds 127 bytes UTF-8');
            }
            break;
        }
        case 'delProxyInfo': {
            const s = args['seqno'];
            if (!s) fail('missing --seqno');
            seqno = parseInt(s, 10);
            if (isNaN(seqno)) fail('--seqno must be an integer');
            break;
        }
        default:
            fail(`unknown --op: ${op}`);
    }

    let rootAddress: Address;
    try {
        rootAddress = Address.parse(rootStr);
    } catch {
        fail(`invalid --root address: ${rootStr}`);
    }

    const endpoint = network === 'mainnet'
        ? 'https://mainnet-v4.tonhubapi.com'
        : 'https://testnet-v4.tonhubapi.com';
    const client = new TonClient4({ endpoint });

    const words   = mnemonic.trim().split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(words);

    let wallet: WalletContractV4;
    if (walletVersion === 'v4r2') {
        wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    } else {
        fail(`unsupported --wallet-version: ${walletVersion}`);
    }

    const openedWallet = client.open(wallet);
    const sender       = openedWallet.sender(keyPair.secretKey);
    const cocoonRoot   = client.open(CocoonRoot.createFromAddress(rootAddress!));

    try {
        switch (op) {
            case 'addWorkerType': {
                if (await cocoonRoot.getWorkerHashIsValid(hashBuf!)) {
                    process.stdout.write(JSON.stringify({ ok: false, code: 'ALREADY_REGISTERED', error: 'worker type hash already registered on-chain' }) + '\n');
                    process.exit(1);
                }
                await cocoonRoot.sendAddWorkerType(sender, hashBuf!);
                break;
            }
            case 'addProxyType': {
                if (await cocoonRoot.getProxyHashIsValid(hashBuf!)) {
                    process.stdout.write(JSON.stringify({ ok: false, code: 'ALREADY_REGISTERED', error: 'proxy type hash already registered on-chain' }) + '\n');
                    process.exit(1);
                }
                await cocoonRoot.sendAddProxyType(sender, hashBuf!);
                break;
            }
            case 'addModelType': {
                if (await cocoonRoot.getModelHashIsValid(hashBuf!)) {
                    process.stdout.write(JSON.stringify({ ok: false, code: 'ALREADY_REGISTERED', error: 'model type hash already registered on-chain' }) + '\n');
                    process.exit(1);
                }
                await cocoonRoot.sendAddModelType(sender, hashBuf!);
                break;
            }
            case 'addProxyInfo': {
                await cocoonRoot.sendAddProxyInfo(sender, valueStr!);
                const assignedSeqno = await cocoonRoot.getLastProxySeqno();
                process.stdout.write(JSON.stringify({ ok: true, seqno: assignedSeqno }) + '\n');
                return;
            }
            case 'delProxyInfo':
                await cocoonRoot.sendDelProxyInfo(sender, seqno!);
                break;
        }
        process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already|exist|duplicate/i.test(msg)) {
            process.stdout.write(JSON.stringify({ ok: false, code: 'ALREADY_REGISTERED' }) + '\n');
            process.exit(1);
        }
        process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
        process.exit(1);
    }
}
