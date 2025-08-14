require('dotenv').config();
const { ethers } = require('ethers');
const PoolABI = require('./abis/IUniswapV3Pool.json').abi;
const RouterABI = require('./abis/SwapRouter.json').abi;
const ERC20ABI = require('./abis/ERC20.json').abi;

// --- Config / Direcciones (con override por ENV si quieres) ---
const RPC_URL = process.env.RPC_URL || 'https://polygon-rpc.com';
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const POOL_ADDRESS = (process.env.POOL_ADDRESS || '0x41e30899FBd500102E5CA0F58C7D9d3955e74b9').toLowerCase();
const ROUTER_ADDRESS = (process.env.UNISWAP_ROUTER_ADDRESS || '0xE592427A0AEce92De3Edee1F18E0157C05861564').toLowerCase();
const TVA_ADDRESS = (process.env.TVA_TOKEN_ADDRESS || '0x7324452980a5CeaD3EaDf1FA92c759390751cA13').toLowerCase();
const USDT_ADDRESS = (process.env.USDT_TOKEN_ADDRESS || '0xc2132D05D31c914a87C6611C10748AEb04B58e8F').toLowerCase(); // USDT correcto en Polygon

const pool = new ethers.Contract(POOL_ADDRESS, PoolABI, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, RouterABI, wallet);
const tva = new ethers.Contract(TVA_ADDRESS, ERC20ABI, wallet);
const usdt = new ethers.Contract(USDT_ADDRESS, ERC20ABI, wallet);

// --- Helpers ---

// Amount aleatorio entero en el rango [min, max]
function randomAmount(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Asegura allowance suficiente para 'spender'
async function ensureAllowance(tokenContract, owner, spender, neededBN) {
  const symbol = (await safeSymbol(tokenContract)) || 'TOKEN';
  const current = await tokenContract.allowance(owner, spender);

  if (current.gte(neededBN)) return true;

  // USDT/Tether suele requerir poner 0 primero
  try {
    if (!current.isZero()) {
      const tx0 = await tokenContract.approve(spender, 0);
      await tx0.wait();
    }
  } catch (_) { /* ignore */ }

  const tx = await tokenContract.approve(spender, neededBN);
  await tx.wait();
  console.log(`✔️  Approved ${symbol} allowance to router`);
  return true;
}

// Algunas veces symbol puede revertir; lo hacemos seguro
async function safeSymbol(tokenContract) {
  try { return await tokenContract.symbol(); } catch (_) { return null; }
}

// Calcula precio TVA/USDT del pool, ajustando decimales y orden token0/token1
async function getTvaPrice() {
  // Datos del pool
  const [sqrtPriceX96, , , , , , ] = await pool.slot0();
  const token0 = (await pool.token0()).toLowerCase();
  const token1 = (await pool.token1()).toLowerCase();

  const token0C = new ethers.Contract(token0, ERC20ABI, provider);
  const token1C = new ethers.Contract(token1, ERC20ABI, provider);
  const [dec0, dec1] = await Promise.all([token0C.decimals(), token1C.decimals()]);

  // price = (sqrtP^2 / 2^192) * 10^(dec1-dec0)
  const Q96 = ethers.BigNumber.from(2).pow(96);
  const Q192 = Q96.mul(Q96);
  const sqrtP = ethers.BigNumber.from(sqrtPriceX96);
  const priceX192 = sqrtP.mul(sqrtP);

  // Escalamos a 1e18 para tener decimal cómodo
  const num = priceX192.mul(ethers.BigNumber.from(10).pow(18 + dec1));
  const den = Q192.mul(ethers.BigNumber.from(10).pow(dec0));
  const priceToken1PerToken0_1e18 = num.div(den); // 18 dec

  const priceToken1PerToken0 = Number(ethers.utils.formatUnits(priceToken1PerToken0_1e18, 18));

  // Queremos TVA/USDT (USDT por 1 TVA).
  // Si token0 == TVA y token1 == USDT → price = token1/token0 (ya es TVA/USDT)
  // Si están al revés → precio = 1 / (token1/token0)
  let tvaPrice;
  if (token0 === TVA_ADDRESS && token1 === USDT_ADDRESS) {
    tvaPrice = priceToken1PerToken0;
  } else if (token0 === USDT_ADDRESS && token1 === TVA_ADDRESS) {
    tvaPrice = 1 / priceToken1PerToken0;
  } else {
    throw new Error('El pool no es TVA/USDT; revisa POOL_ADDRESS y direcciones.');
  }
  return { tvaPrice, token0, token1 };
}

async function swapExactInput({ amountInUnits, tokenIn, tokenOut, fee }) {
  const recipient = await wallet.getAddress();
  const params = {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10,
    amountIn: amountInUnits,
    amountOutMinimum: 0,        // ⚠️ Sin protección de slippage (simple). Para mejorar: usar Quoter.
    sqrtPriceLimitX96: 0
  };
  const tx = await router.exactInputSingle(params, { gasLimit: 500000 });
  console.log(`⛓️  Tx enviada: ${tx.hash}`);
  const rec = await tx.wait();
  console.log(`✅ Swap confirmado en bloque ${rec.blockNumber}`);
}

async function main() {
  const addr = (await wallet.getAddress());
  console.log(`👤 Wallet: ${addr.slice(0, 6)}…${addr.slice(-4)} (Polygon)`);
  console.log(`🔗 RPC: ${RPC_URL}`);

  // Lee fee del pool y precio
  const fee = await pool.fee(); // 500 / 3000 / 10000…
  const { tvaPrice } = await getTvaPrice();
  console.log(`💹 Precio TVA/USDT: $${tvaPrice.toFixed(6)} (fee: ${fee})`);

  // Rangos y tamaños aleatorios
  const SELL_TRIGGER = 0.054;
  const BUY_TRIGGER  = 0.047;
  const TARGET_LOW   = 0.049;
  const TARGET_HIGH  = 0.051;

  // Decimales
  const [tvaDec, usdtDec] = await Promise.all([tva.decimals(), usdt.decimals()]);

  if (tvaPrice >= SELL_TRIGGER) {
    // Si está por encima del alto, vende 100–1000 TVA (si tienes balance)
    const amount = randomAmount(100, 1000);
    const bal = await tva.balanceOf(addr);
    const need = ethers.utils.parseUnits(String(amount), tvaDec);

    if (bal.gte(need)) {
      console.log(`📤 Precio alto. Vendiendo ${amount} TVA por USDT…`);
      await ensureAllowance(tva, addr, ROUTER_ADDRESS, need);
      await swapExactInput({ amountInUnits: need, tokenIn: TVA_ADDRESS, tokenOut: USDT_ADDRESS, fee });
    } else {
      console.log(`⚠️ Saldo TVA insuficiente: tienes ${ethers.utils.formatUnits(bal, tvaDec)} TVA`);
    }
  } else if (tvaPrice <= BUY_TRIGGER) {
    // Si está por debajo del bajo, compra 100–1000 TVA con USDT (si tienes USDT)
    const amount = randomAmount(100, 1000); // interpretamos "100–1000 TVA-equivalente" en USDT aprox.
    const need = ethers.utils.parseUnits(String(amount), usdtDec); // gastamos X USDT (100–1000)

    const usdtBal = await usdt.balanceOf(addr);
    if (usdtBal.gte(need)) {
      console.log(`📥 Precio bajo. Comprando TVA con ${amount} USDT…`);
      await ensureAllowance(usdt, addr, ROUTER_ADDRESS, need);
      await swapExactInput({ amountInUnits: need, tokenIn: USDT_ADDRESS, tokenOut: TVA_ADDRESS, fee });
    } else {
      console.log(`⚠️ Saldo USDT insuficiente: tienes ${ethers.utils.formatUnits(usdtBal, usdtDec)} USDT`);
    }
  } else if (tvaPrice >= TARGET_LOW && tvaPrice <= TARGET_HIGH) {
    console.log('⏹ Precio dentro del rango objetivo. No hacemos nada.');
  } else {
    console.log('ℹ️ Precio fuera de triggers pero fuera del rango objetivo. Esperando al próximo run.');
  }
}

main().catch((e) => {
  console.error('❌ Error en bot:', e.message || e);
  process.exit(1);
});

