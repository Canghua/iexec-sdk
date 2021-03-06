const Debug = require('debug');
const fs = require('fs-extra');
const ora = require('ora');
const Promise = require('bluebird');
const inquirer = require('inquirer');
const fetch = require('node-fetch');
const { genKeyPair } = require('@warren-bank/ethereumjs-tx-sign/lib/keypairs');
const {
  privateToPublic,
} = require('@warren-bank/ethereumjs-tx-sign/lib/keypairs');
const {
  publicToAddress,
} = require('@warren-bank/ethereumjs-tx-sign/lib/keypairs');
const rlcJSON = require('rlc-faucet-contract/build/contracts/RLC.json');
const utils = require('./utils');
const oraOptions = require('./oraOptions');

const debug = Debug('iexec:wallet');
const openAsync = Promise.promisify(fs.open);
const writeAsync = Promise.promisify(fs.write);
const readFileAsync = Promise.promisify(fs.readFile);
const writeFileAsync = Promise.promisify(fs.writeFile);

const WALLET_FILE_NAME = 'wallet.json';
const OVERWRITE_CONFIRMATION = `${WALLET_FILE_NAME} already exists, replace it with new wallet?`;
const CREATE_CONFIRMATION = `You don't have a ${WALLET_FILE_NAME} yet, create one?`;

const walletFromPrivKey = (privateKey) => {
  const publicKey = privateToPublic(privateKey);
  const address = publicToAddress(publicKey);

  return {
    privateKey,
    publicKey,
    address,
  };
};

const save = async (userWallet) => {
  const userJSONWallet = JSON.stringify(userWallet, null, 4);
  try {
    const fd = await openAsync(WALLET_FILE_NAME, 'wx');
    await writeAsync(fd, userJSONWallet, 0, 'utf8');
    return fs.close(fd);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'overwrite',
          message: OVERWRITE_CONFIRMATION,
        },
      ]);
      if (answers.overwrite) {
        return writeFileAsync(WALLET_FILE_NAME, userJSONWallet);
      }
      return console.log('keeping old wallet');
    }
    debug('save() error', error);
    throw error;
  }
};

const create = async () => {
  const userWallet = genKeyPair();
  await save(userWallet);
  console.log('Wallet successfully created!');
  return userWallet;
};

const load = async () => {
  try {
    const userWalletJSON = await readFileAsync(WALLET_FILE_NAME, 'utf8');
    debug('userWalletJSON', userWalletJSON);
    const userWallet = JSON.parse(userWalletJSON);
    return walletFromPrivKey(userWallet.privateKey);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'create',
          message: CREATE_CONFIRMATION,
        },
      ]);
      if (answers.create) {
        return create();
      }

      throw new Error('Aborting. You need a wallet to continue');
    }
    debug('load() error', error);
    throw error;
  }
};

const ethFaucets = [
  {
    chainName: 'ropsten',
    name: 'faucet.ropsten.be',
    getETH: address =>
      fetch(`http://faucet.ropsten.be:3001/donate/${address}`)
        .then(res => res.json())
        .catch(() => ({ error: 'ETH faucet is down.' })),
  },
  {
    chainName: 'ropsten',
    name: 'ropsten.faucet.b9lab.com',
    getETH: address =>
      fetch('https://ropsten.faucet.b9lab.com/tap', {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify({ toWhom: '0x'.concat(address) }),
      })
        .then(res => res.json())
        .catch(() => ({ error: 'ETH faucet is down.' })),
  },
  {
    chainName: 'rinkeby',
    name: 'faucet.rinkeby.io',
    getETH: () => ({
      message: 'Go to https://faucet.rinkeby.io/ to manually ask for ETH',
    }),
  },
  {
    chainName: 'kovan',
    name: 'gitter.im/kovan-testnet/faucet',
    getETH: () => ({
      message:
        'Go to https://gitter.im/kovan-testnet/faucet to manually ask for ETH',
    }),
  },
];

const getETH = async (chainName) => {
  const spinner = ora(oraOptions);
  try {
    const userWallet = await load();

    spinner.start(`Requesting ETH from ${chainName} faucets...`);
    const filteredFaucets = ethFaucets.filter(e => e.chainName === chainName);
    const responses = await Promise.all(filteredFaucets.map(faucet => faucet.getETH(userWallet.address)));
    const responsesMessage = filteredFaucets.reduce(
      (accu, curr, index) =>
        accu.concat(
          '- ',
          curr.name,
          ' : \n',
          JSON.stringify(responses[index], null, '\t'),
          '\n\n',
        ),
      '',
    );
    spinner.succeed('Faucets responses:\n');
    console.log(responsesMessage);
  } catch (error) {
    spinner.fail(`getETH() failed with ${error}`);
    throw error;
  }
};

const rlcFaucets = [
  {
    name: 'faucet.iex.ec',
    getRLC: (chainName, address) =>
      fetch(`https://api.faucet.iex.ec/getRLC?chainName=${chainName}&address=${address}`).then(res => res.json()),
  },
];

const getRLC = async (chainName) => {
  const spinner = ora(oraOptions);
  try {
    const userWallet = await load();

    spinner.start(`Requesting ${chainName} faucet for nRLC...`);
    const responses = await Promise.all(rlcFaucets.map(faucet => faucet.getRLC(chainName, userWallet.address)));
    const responsesMessage = rlcFaucets.reduce(
      (accu, curr, index) =>
        accu.concat(
          '- ',
          curr.name,
          ' : \n',
          JSON.stringify(responses[index], null, '\t'),
          '\n\n',
        ),
      '',
    );
    spinner.succeed('Faucets responses:\n');
    console.log(responsesMessage);
  } catch (error) {
    spinner.fail(`getRLC() failed with ${error}`);
    throw error;
  }
};

const show = async () => {
  const spinner = ora(oraOptions);
  try {
    const userWallet = await load();

    spinner.info('Wallet:\n');
    console.log(JSON.stringify(userWallet, null, 4), '\n');
    spinner.start('Checking ETH balances...');

    const chains = utils.getChains();

    const networkNames = Object.keys(utils.truffleConfig.networks);
    const ethBalances = await Promise.all(networkNames.map(name =>
      chains[name].web3.eth
        .getBalanceAsync(userWallet.address)
        .then(balance => chains[name].web3.fromWei(balance, 'ether'))
        .catch((error) => {
          debug(error);
          return 0;
        })));
    spinner.info('ETH balances:\n');
    const ethBalancesString = ethBalances.reduce(
      (accu, curr, index) =>
        accu.concat(`  ${networkNames[index]}: \t ${curr} ETH \t\t https://${
          networkNames[index]
        }.etherscan.io/address/${userWallet.address}\n`),
      '',
    );

    console.log(ethBalancesString, '\n');
    console.log('Run "iexec wallet getETH" to top up your ETH account\n');

    spinner.start('Checking nRLC balances...');
    const chainIDs = Object.keys(rlcJSON.networks).filter(id => id in chains);

    const rlcBalances = await Promise.all(chainIDs.map((id) => {
      const rlcAddress = rlcJSON.networks[id].address;
      const rlcContract = chains[id].web3.eth
        .contract(rlcJSON.abi)
        .at(rlcAddress);
      Promise.promisifyAll(rlcContract);
      return rlcContract.balanceOfAsync('0x'.concat(userWallet.address));
    }));

    spinner.info('nRLC balances:\n');
    const rlcBalancesString = chainIDs.reduce(
      (accu, curr, index) =>
        accu.concat(`  ${chains[curr].name}: \t ${rlcBalances[index]} nRLC\n`),
      '',
    );

    console.log(rlcBalancesString, '\n');
    console.log('Run "iexec wallet getRLC" to top up your nRLC account\n');
  } catch (error) {
    spinner.fail(`show() failed with ${error}`);
    throw error;
  }
};

const sendETH = async (chainName, amount, to = 'iexec') => {
  const spinner = ora(oraOptions);
  try {
    const userWallet = await load();
    const toAddress = utils.getOracleWallet(to);

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'transfer',
        message: `Do you want to send ${amount} ${chainName} ETH to ${to}`,
      },
    ]);
    if (!answers.transfer) throw Error('Transfer aborted by user.');

    spinner.start(`Sending ${amount} ${chainName} ETH to ${to}...`);
    const chain = utils.getChains()[chainName];

    const txHash = await utils.signAndSendTx({
      chain,
      userWallet,
      contractAddress: toAddress,
      value: chain.web3.toWei(amount, 'ether'),
    });
    spinner.info(`transfer txHash: ${txHash} \n`);

    spinner.start('waiting for transaction to be mined');
    const txReceipt = await utils.waitFor(
      chain.web3.eth.getTransactionReceiptAsync,
      txHash,
    );

    debug('txReceipt:', JSON.stringify(txReceipt, null, 4));
    spinner.info(`View on etherscan: ${utils
      .chainToEtherscanURL(chainName)
      .concat(txReceipt.transactionHash)}\n`);
    spinner.succeed(`${amount} ${chainName} ETH sent to ${to}\n`);
  } catch (error) {
    spinner.fail(`sendETH() failed with ${error}`);
    throw error;
  }
};

const sendRLC = async (chainName, amount, to = 'iexec') => {
  const spinner = ora(oraOptions);
  try {
    const userWallet = await load();
    const toAddress = utils.getFaucetWallet(to);
    debug('toAddress', toAddress);

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'transfer',
        message: `Do you want to send ${amount} ${chainName} nRLC to ${to}`,
      },
    ]);
    if (!answers.transfer) throw Error('Transfer aborted by user.');

    spinner.start(`Sending ${amount} ${chainName} nRLC to ${to}...`);
    const chain = utils.getChains()[chainName];
    const rlcAddress = rlcJSON.networks[chain.id].address;
    const rlcContract = chain.web3.eth.contract(rlcJSON.abi).at(rlcAddress);
    const transferAmount = parseInt(amount, 10);
    const unsignedTx = rlcContract.transfer.getData(toAddress, transferAmount);

    const txHash = await utils.signAndSendTx({
      chain,
      userWallet,
      unsignedTx,
      contractAddress: rlcAddress,
    });
    spinner.info(`transfer txHash: ${txHash} \n`);

    spinner.start('waiting for transaction to be mined');
    const txReceipt = await utils.waitFor(
      chain.web3.eth.getTransactionReceiptAsync,
      txHash,
    );

    const tx = await chain.web3.eth.getTransactionAsync(txHash);
    utils.checkTxReceipt(txReceipt, tx.gas);

    debug('txReceipt:', JSON.stringify(txReceipt, null, 4));
    spinner.info(`View on etherscan: ${utils
      .chainToEtherscanURL(chainName)
      .concat(txReceipt.transactionHash)}\n`);
    spinner.succeed(`${amount} ${chainName} nRLC sent to ${to}\n`);
  } catch (error) {
    spinner.fail(`sendRLC() failed with ${error}`);
    throw error;
  }
};

const sweep = async (chainName, to = 'iexec') => {
  const spinner = ora(oraOptions);
  try {
    const userWallet = await load();

    const chain = utils.getChains()[chainName];

    const rlcAddress = rlcJSON.networks[chain.id].address;
    const rlcContract = chain.web3.eth.contract(rlcJSON.abi).at(rlcAddress);
    Promise.promisifyAll(rlcContract);
    const rlcBalance = await rlcContract.balanceOfAsync('0x'.concat(userWallet.address));
    debug('rlcBalance', rlcBalance.toNumber());
    if (rlcBalance.toNumber() > 0) await sendRLC(chainName, rlcBalance, to);

    const ethBalance = await chain.web3.eth
      .getBalanceAsync(userWallet.address)
      .then(balance => chain.web3.fromWei(balance, 'ether'));
    debug('ethBalance', ethBalance.toNumber());
    const ethToSweep = ethBalance.toNumber() - 0.01;
    if (ethToSweep > 0) await sendETH(chainName, ethToSweep, to);

    spinner.succeed(`wallet swept to ${to}\n`);
  } catch (error) {
    spinner.fail(`sweep() failed with ${error}`);
    throw error;
  }
};

module.exports = {
  walletFromPrivKey,
  save,
  create,
  load,
  getETH,
  getRLC,
  show,
  sendETH,
  sendRLC,
  sweep,
};
