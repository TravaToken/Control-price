require('dotenv').config();
const { ethers } = require('ethers');
const { abi: IUniswapV3PoolABI } = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json');
const { abi: SwapRouterABI } = require('@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json');
const { abi: ERC20ABI } = require('@openzeppelin/contracts/build/contracts/ERC20.json');

// RPC Polygon
const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Direcciones
const POOL_ADDRESS = "0x41e30899FBd500102E5CA0F58C7D9d3955e74b9"; // Pool TVA/USDT en Uniswap v3
const ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap v3 Router en Polygon
const TVA_ADDRESS = "0x7324452980a5CeaD3EaDf1FA92c759390751cA13"; // TVA token
const USDT_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDT Polygon (6 decimales)

// Contratos
const poolContract = new ethers.Contract(POOL_ADDRESS, IUniswapV3PoolABI, provider);
const routerContract = new ethers.Contract(ROUTER_ADDRESS, SwapRouterABI, wallet);
const tvaContract = new ethers.Contract(TVA_ADDRESS, ERC20ABI, wallet);
const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20ABI, wallet);

async function getPrice() {
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0[0];
    const price = (Number(sqrtPriceX96) ** 2) / (2 ** 192); // Precio TVA/USDT
    return price;
}

// Aleatorio entre min y max
function randomAmount(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Aleatorio para intervalo en ms
function randomInterval(minMinutes, maxMinutes) {
    return randomAmount(minMinutes * 60000, maxMinutes * 60000);
}

async function hasEnoughBalance(tokenAddress, decimals, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20ABI, wallet);
    const balance = await token.balanceOf(wallet.address);
    const balanceReadable = parseFloat(ethers.utils.formatUnits(balance, decimals));
    return balanceReadable >= amount;
}

async function swap(amountIn, tokenIn, tokenOut, decimalsIn) {
    const params = {
        tokenIn,
        tokenOut,
        fee: 3000,
        recipient: await wallet.getAddress(),
        deadline: Math.floor(Date.now() / 1000) + 60 * 10,
        amountIn: ethers.utils.parseUnits(amountIn.toString(), decimalsIn),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    };

    const tx = await routerContract.exactInputSingle(params, { gasLimit: 300000 });
    await tx.wait();
    console.log(`✅ Swap completado: ${amountIn} ${tokenIn} → ${tokenOut}`);
}

let mode = null;

async function main() {
    try {
        const price = await getPrice();
        console.log(`💹 Precio actual TVA/USDT: $${price.toFixed(6)}`);

        // Venta
        if (price >= 0.054 && (mode === null || mode === "sell")) {
            const amount = randomAmount(100, 1000);
            if (await hasEnoughBalance(TVA_ADDRESS, 18, amount)) {
                console.log(`📤 Precio alto. Vendiendo ${amount} TVA...`);
                await swap(amount, TVA_ADDRESS, USDT_ADDRESS, 18);
                mode = "sell";
            } else {
                console.log("⚠️ Saldo insuficiente de TVA para vender.");
            }
        }

        // Compra
        else if (price <= 0.047 && (mode === null || mode === "buy")) {
            const amount = randomAmount(100, 1000);
            if (await hasEnoughBalance(USDT_ADDRESS, 6, amount)) {
                console.log(`📥 Precio bajo. Comprando ${amount} TVA...`);
                await swap(amount, USDT_ADDRESS, TVA_ADDRESS, 6);
                mode = "buy";
            } else {
                console.log("⚠️ Saldo insuficiente de USDT para comprar.");
            }
        }

        // Rango óptimo
        if (price >= 0.049 && price <= 0.051) {
            console.log(`⏹ Precio en rango óptimo. Modo reiniciado.`);
            mode = null;
        }
    } catch (err) {
        console.error("❌ Error en el bot:", err);
    }

    // Ejecutar de nuevo en 5-10 minutos
    const delay = randomInterval(5, 10);
    console.log(`⏳ Próxima ejecución en ${(delay / 60000).toFixed(1)} minutos...\n`);
    setTimeout(main, delay);
}

// Iniciar
main();
