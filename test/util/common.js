'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('bfile');
const bio = require('bufio');
const Block = require('../../lib/primitives/block');
const MerkleBlock = require('../../lib/primitives/merkleblock');
const Headers = require('../../lib/primitives/headers');
const {CompactBlock} = require('../../lib/net/bip152');
const TX = require('../../lib/primitives/tx');
const Output = require('../../lib/primitives/output');
const CoinView = require('../../lib/coins/coinview');

const common = exports;

common.readFile = function readFile(name, enc) {
  const file = path.resolve(__dirname, '..', 'data', name);
  return fs.readFileSync(file, enc);
};

common.writeFile = function writeFile(name, data) {
  const file = path.resolve(__dirname, '..', 'data', name);
  return fs.writeFileSync(file, data);
};

common.exists = function exists(name) {
  const file = path.resolve(__dirname, '..', 'data', name);
  return fs.existsSync(file);
};

common.readBlock = function readBlock(name) {
  const raw = common.readFile(`${name}.raw`);

  if (!common.exists(`${name}-undo.raw`))
    return new BlockContext(Block, raw);

  const undoRaw = common.readFile(`${name}-undo.raw`);

  return new BlockContext(Block, raw, undoRaw);
};

common.readMerkle = function readMerkle(name) {
  const raw = common.readFile(`${name}.raw`);
  return new BlockContext(MerkleBlock, raw);
};

common.readCompact = function readCompact(name) {
  const raw = common.readFile(`${name}.raw`);
  return new BlockContext(CompactBlock, raw);
};

common.readTX = function readTX(name) {
  const raw = common.readFile(`${name}.raw`);

  if (!common.exists(`${name}-undo.raw`))
    return new TXContext(raw);

  const undoRaw = common.readFile(`${name}-undo.raw`);

  return new TXContext(raw, undoRaw);
};

common.writeBlock = function writeBlock(name, block, view) {
  common.writeFile(`${name}.raw`, block.toRaw());

  if (!view)
    return;

  const undo = makeBlockUndo(block, view);
  const undoRaw = serializeUndo(undo);

  common.writeFile(`${name}-undo.raw`, undoRaw);
};

common.writeTX = function writeTX(name, tx, view) {
  common.writeFile(`${name}.raw`, tx.toRaw());

  if (!view)
    return;

  const undo = makeTXUndo(tx, view);
  const undoRaw = serializeUndo(undo);

  common.writeFile(`${name}-undo.raw`, undoRaw);
};

common.rimraf = async function(p) {
  const allowed = new RegExp('^\/tmp\/(.*)$');
  if (!allowed.test(p))
    throw new Error(`Path not allowed: ${p}.`);

  return await fs.rimraf(p);
};

common.sleep = async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

function parseUndo(data) {
  const br = bio.read(data);
  const items = [];

  while (br.left()) {
    const output = Output.fromReader(br);
    items.push(output);
  }

  return items;
}

function serializeUndo(items) {
  const bw = bio.write();

  for (const item of items) {
    bw.writeI64(item.value);
    bw.writeVarBytes(item.script.toRaw());
  }

  return bw.render();
}

function applyBlockUndo(block, undo) {
  const view = new CoinView();
  let i = 0;

  for (const tx of block.txs) {
    if (tx.isCoinbase())
      continue;

    for (const {prevout} of tx.inputs)
      view.addOutput(prevout, undo[i++]);
  }

  assert(i === undo.length, 'Undo coins data inconsistency.');

  return view;
}

function applyTXUndo(tx, undo) {
  const view = new CoinView();
  let i = 0;

  for (const {prevout} of tx.inputs)
    view.addOutput(prevout, undo[i++]);

  assert(i === undo.length, 'Undo coins data inconsistency.');

  return view;
}

function makeBlockUndo(block, view) {
  const items = [];

  for (const tx of block.txs) {
    if (tx.isCoinbase())
      continue;

    for (const {prevout} of tx.inputs) {
      const coin = view.getOutput(prevout);
      assert(coin);
      items.push(coin);
    }
  }

  return items;
}

function makeTXUndo(tx, view) {
  const items = [];

  for (const {prevout} of tx.inputs) {
    const coin = view.getOutput(prevout);
    assert(coin);
    items.push(coin);
  }

  return items;
}

class BlockContext {
  constructor(ctor, raw, undoRaw) {
    this.ctor = ctor;
    this.raw = raw;
    this.undoRaw = undoRaw || null;
  }
  getRaw() {
    return this.raw;
  }
  getBlock() {
    const Block = this.ctor;
    const block = Block.fromRaw(this.raw);

    if (!this.undoRaw) {
      const view = new CoinView();
      return [block, view];
    }

    const undo = parseUndo(this.undoRaw);
    const view = applyBlockUndo(block, undo);

    return [block, view];
  }
  getHeaders() {
    return Headers.fromHead(this.raw);
  }
}

class TXContext {
  constructor(raw, undoRaw) {
    this.raw = raw;
    this.undoRaw = undoRaw || null;
  }
  getRaw() {
    return this.raw;
  }
  getTX() {
    const tx = TX.fromRaw(this.raw);

    if (!this.undoRaw) {
      const view = new CoinView();
      return [tx, view];
    }

    const undo = parseUndo(this.undoRaw);
    const view = applyTXUndo(tx, undo);

    return [tx, view];
  }
}
