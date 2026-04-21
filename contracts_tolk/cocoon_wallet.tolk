import "@stdlib/gas-payments"
import "errors"
import "opcodes"
import "storage"

// === Wallet-specific Constants and Types ===

const SIZE_SIGNATURE = 512
const STATUS_BLOCKED = 1
const WALLET_MIN_BALANCE = ton("2.0")
const WALLET_RESERVE_AMOUNT = ton("0.01")

// External message struct (after signature)
struct ExternalSignedMessage {
    subwalletId: uint32
    validUntil: uint32
    msgSeqno: uint32
    rest: RemainingBitsAndRefs  // Contains mode + message refs
}

// Internal message structs
struct (0x9c69f376) OwnerWalletSendMessage {
    queryId: uint64
    mode: uint8
    body: cell
}

// Text command actions
const TEXT_ACTION_WITHDRAW = 119 // "w"
const TEXT_ACTION_BLOCK = 98     // "b"
const TEXT_ACTION_UNBLOCK = 117  // "u"

// Text command markers (op == 0)
struct (0x00000000) TextCommand {
    action: uint8
}

// Allowed internal messages
type AllowedInternalMessage = OwnerWalletSendMessage | TextCommand

// === External Message Handler (signed by owner) ===

fun onExternalMessage(inMsg: slice) {
    val signature = inMsg.loadBits(SIZE_SIGNATURE);
    val msg = ExternalSignedMessage.fromSlice(inMsg);

    assert (msg.validUntil > blockchain.now()) throw ERROR_WALLET_EXPIRED;

    var storage = WalletStorage.load();

    assert (!(storage.status & STATUS_BLOCKED)) throw ERROR_WALLET_BLOCKED;
    assert (msg.msgSeqno == storage.seqno) throw ERROR_WALLET_INVALID_SEQNO;
    assert (msg.subwalletId == storage.subwalletId) throw ERROR_WALLET_INVALID_SUBWALLET;
    assert (isSignatureValid(inMsg.hash(), signature, storage.publicKey)) throw ERROR_WALLET_BAD_SIGNATURE;
    assert (contract.getOriginalBalance() >= WALLET_MIN_BALANCE) throw ERROR_WALLET_LOW_BALANCE;

    acceptExternalMessage();

    // Send all messages from the list
    var remaining = msg.rest;
    while (remaining.remainingRefsCount() > 0) {
        val mode = remaining.loadUint(8);
        sendRawMessage(remaining.loadRef(), mode);
    }

    // Update seqno
    storage.seqno += 1;
    storage.save();
}

// === Internal Message Handler ===

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) {
        return;
    }

    val op = in.body.preloadUint(32);

    // Ignore these opcodes
    if (op == OP_EXCESSES || op == OP_PAYOUT || op == OP_DO_NOT_PROCESS) {
        return;
    }

    var storage = lazy WalletStorage.load();

    // Only owner can send internal messages
    assert (in.senderAddress == storage.ownerAddress) throw ERROR_WALLET_EXPECTED_OWNER;

    val msg = lazy AllowedInternalMessage.fromSlice(in.body);

    match (msg) {
        OwnerWalletSendMessage => {
            sendRawMessage(msg.body, msg.mode);
        },

        TextCommand => {
            match (msg.action) {
                TEXT_ACTION_WITHDRAW => {
                    reserveToncoinsOnBalance(WALLET_RESERVE_AMOUNT, RESERVE_MODE_AT_MOST);  // Keep contract alive

                    createMessage({
                        bounce: BounceMode.Only256BitsOfBody,
                        dest: in.senderAddress,
                        value: 0,
                        body: TextCommand{
                            action: TEXT_ACTION_WITHDRAW
                        }
                    }).send(SEND_MODE_CARRY_ALL_BALANCE);
                },
                TEXT_ACTION_BLOCK => {
                    storage.status = storage.status | STATUS_BLOCKED;
                    storage.save();
                },
                TEXT_ACTION_UNBLOCK => {
                    storage.status = storage.status & ~STATUS_BLOCKED;
                    storage.save();
                },
                else => {
                    throw ERROR_WALLET_UNKNOWN_TEXT_OP;
                }
            }
        }
    }
}

// === Get Methods ===

get fun seqno(): int {
    val storage = lazy WalletStorage.load();
    return storage.seqno;
}

get fun get_public_key(): int {
    val storage = lazy WalletStorage.load();
    return storage.publicKey;
}

get fun get_owner_address(): address {
    val storage = lazy WalletStorage.load();
    return storage.ownerAddress;
}
