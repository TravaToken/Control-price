const { ethers } = require("ethers");
const fetch = require("node-fetch");

require('dotenv').config();

const RPC_URL = "https://polygon-rpc.com";
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const TVA_ADDRESS = "0x7324452980a5CeaD3EaDf1FA92c759390751cA13";
const USDT_ADDRESS = "0x41e30899FBd500102E5CA0F58C7D9d3955e74b9";

async function getPrice() {
    const url = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
    // Aquí iría la consulta real a Uniswap v3 para precio TVA/USDT
    console.log("Simulación de precio: 0.05");
    return 0.05; // Cambiar por precio real
}

async function trade() {
    const price = await getPrice();
    console.log(`Precio actual: ${price}`);

    if (price >= 0.054) {
        console.log("Vender TVA por USDT");
        // Aquí iría la transacción real
    } else if (price <= 0.046) {
        console.log("Comprar TVA con USDT");
        // Aquí iría la transacción real
    } else {
        console.log("No se hace nada");
    }
}

trade();
