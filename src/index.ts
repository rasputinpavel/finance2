import 'dotenv/config';
import { request, gql } from 'graphql-request';
import nodemailer from 'nodemailer';
import dns from 'dns';
import { JsonRpcProvider, Contract, formatUnits, type BigNumberish, BaseContract, Interface } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exit } from 'process';
interface AaveAccount {
    positions: AavePosition[];
}
interface AaveResponse {
    accounts: AaveAccount[];
}
interface AavePosition {
    balance: string;
    side: string;
    isCollateral: boolean;
    market: {
        liquidationThreshold: string;
        inputToken: {
            symbol: string;
            decimals: string;
            lastPriceUSD: string;
        };
    };
}
interface UniPoolToken {
    symbol: string;
    decimals: string;
    address: string;
}
interface UniPool {
    feeTier: string;
    token0: UniPoolToken;
    token1: UniPoolToken;
}
interface UniPosition {
    id: string;
    pool: UniPool;
    liquidity: string;
}
interface State {
    [tokenId: string]: {
        date: string;
        owedUSD: number;
        owedETH: number;
        owedUSDC: number;
    };
}
interface NpmContract extends BaseContract {
    collect: {
        staticCall: (params: {
            tokenId: bigint;
            recipient: string;
            amount0Max: bigint;
            amount1Max: bigint;
        }) => Promise<{ 0: BigNumberish; 1: BigNumberish }>;
    };
    balanceOf: (address: string) => Promise<bigint>;
    tokenOfOwnerByIndex: (address: string, index: bigint) => Promise<bigint>;
    positions: (tokenId: bigint) => Promise<
        [
            bigint, // nonce
            string, // operator
            string, // token0
            string, // token1
            bigint, // fee
            bigint, // tickLower
            bigint, // tickUpper
            bigint, // liquidity
            bigint, // feeGrowthInside0LastX128
            bigint, // feeGrowthInside1LastX128
            bigint, // tokensOwed0
            bigint, // tokensOwed1
        ]
    >;
}
interface Erc20Contract extends BaseContract {
    symbol: () => Promise<string>;
    decimals: () => Promise<bigint>;
}
interface CoinGeckoResponse {
    ethereum?: {
        usd?: number;
    };
}
const ADDR = (process.env.WALLET_ADDRESS || '').toLowerCase();
if (!ADDR) {
    console.error('Missing WALLET_ADDRESS in .env');
    process.exit(1);
}
const THE_GRAPH_API_KEY = process.env.THE_GRAPH_API_KEY || '';
if (!THE_GRAPH_API_KEY) {
    console.error('Please add your The Graph API key to the .env file (THE_GRAPH_API_KEY=...).');
    process.exit(1);
}
const AAVE_GQL = `https://gateway-arbitrum.network.thegraph.com/api/${THE_GRAPH_API_KEY}/subgraphs/id/4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf`;
const RPC_URL = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';
const NPM_ADDR = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const NPM_ABI: string[] = [
    'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
    'function ownerOf(uint256) view returns (address)',
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
    'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];
const ERC20_ABI: string[] = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');
const loadState = (): State => {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return {};
    }
};
const saveState = (s: State): void => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
};
const fmt = (n: number, d = 2): string => {
    return n.toFixed(d);
};
const AAVE_Q = gql`
    query ($user: ID!) {
        accounts(where: { id: $user }) {
            positions {
                balance
                side
                isCollateral
                market {
                    liquidationThreshold
                    inputToken {
                        symbol
                        decimals
                        lastPriceUSD
                    }
                }
            }
        }
    }
`;
const main = async (): Promise<void> => {
    console.log('Starting main');
    const nowISO = new Date().toISOString();
    console.log('Fetching ETH price');
    let pr: CoinGeckoResponse;
    try {
        pr = (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd').then((r) =>
            r.json(),
        )) as CoinGeckoResponse;
    } catch (e) {
        console.error('Error fetching ETH price:', e);
        throw e;
    }
    const ethPrice = pr?.ethereum?.usd || 0;
    console.log('ETH price:', ethPrice);
    console.log('Fetching Aave data');
    const aaveRes = await request<AaveResponse>(AAVE_GQL, AAVE_Q, { user: ADDR });
    console.log('Aave data fetched', JSON.stringify(aaveRes, null, 2));
    let totalCollateralUSD = 0;
    let totalDebtUSD = 0;
    let sumCollateralThresholdUSD = 0;
    const user = aaveRes.accounts?.[0];
    const positions = user?.positions || [];
    for (const ur of positions) {
        const reserve = ur.market.inputToken;
        const decimals = parseInt(reserve.decimals);
        const priceNum = parseFloat(reserve.lastPriceUSD) || 0;
        const amount = parseFloat(ur.balance) / Math.pow(10, decimals);
        const valueUSD = amount * priceNum;
        if (ur.side === 'COLLATERAL') {
            totalCollateralUSD += valueUSD;
            if (ur.isCollateral) {
                const liqThreshold = parseFloat(ur.market.liquidationThreshold) / 100;
                sumCollateralThresholdUSD += valueUSD * liqThreshold;
            }
        } else if (ur.side === 'BORROWER') {
            totalDebtUSD += valueUSD;
        }
    }
    const healthFactor = totalDebtUSD === 0 ? Infinity : sumCollateralThresholdUSD / totalDebtUSD;
    const collateral = totalCollateralUSD;
    const debt = totalDebtUSD;
    const liqThresholdBP = totalCollateralUSD === 0 ? 0 : (sumCollateralThresholdUSD / totalCollateralUSD) * 10000;
    const liqThreshold = liqThresholdBP / 10000;
    const ltv = collateral ? debt / collateral : 0;
    const bufferToLiq = liqThreshold ? 1 - ltv / liqThreshold : 0;
    console.log('Aave Health Factor:', healthFactor);
    console.log('Fetching Uniswap data directly from contract');
    const provider = new JsonRpcProvider(RPC_URL);
    const npm = new Contract(NPM_ADDR, NPM_ABI, provider) as unknown as NpmContract;
    const balance = await npm.balanceOf(ADDR);
    console.log('Uniswap positions count:', Number(balance));
    let pos: UniPosition | undefined;
    for (let i = 0n; i < balance; i++) {
        const tokenId = await npm.tokenOfOwnerByIndex(ADDR, i);
        const positionData = await npm.positions(tokenId);
        const [, , token0Addr, token1Addr, fee, , , liquidity] = positionData;
        if (Number(liquidity) === 0) continue; // skip zero liquidity
        const erc20Iface = new Interface(ERC20_ABI);
        const token0 = new Contract(token0Addr, erc20Iface, provider) as unknown as Erc20Contract;
        const token1 = new Contract(token1Addr, erc20Iface, provider) as unknown as Erc20Contract;
        const sym0 = await token0.symbol();
        const sym1 = await token1.symbol();
        const d0 = Number(await token0.decimals());
        const d1 = Number(await token1.decimals());
        const feeTier = Number(fee).toString();
        const s0 = sym0.toUpperCase();
        const s1 = sym1.toUpperCase();
        const TARGET_FEE_TIER = '500';
        const TARGET_TOKEN_A = 'WETH';
        const TARGET_TOKEN_B = 'USDC';
        const feeMatch = feeTier === TARGET_FEE_TIER;
        const pairMatch =
            (s0.includes(TARGET_TOKEN_A) && s1.includes(TARGET_TOKEN_B)) ||
            (s0.includes(TARGET_TOKEN_B) && s1.includes(TARGET_TOKEN_A));
        if (feeMatch && pairMatch) {
            pos = {
                id: tokenId.toString(),
                liquidity: liquidity.toString(),
                pool: {
                    feeTier,
                    token0: { symbol: sym0, decimals: d0.toString() },
                    token1: { symbol: sym1, decimals: d1.toString() },
                },
            };
            break;
        }
    }
    let tokenId = pos?.id;
    console.log('Selected position tokenId:', tokenId);
    let owedUSD = 0,
        owedETH = 0,
        owedUSDC = 0,
        deltaUSD = 0;
    if (tokenId) {
        console.log('Connecting to RPC and calling collect staticCall');
        const Max = 2n ** 128n - 1n;
        const { '0': amount0Raw, '1': amount1Raw } = await npm.collect.staticCall({
            tokenId: BigInt(tokenId),
            recipient: '0x0000000000000000000000000000000000000000',
            amount0Max: Max,
            amount1Max: Max,
        });
        if (!pos) {
            console.error('No pos');
            exit();
        }
        const token0 = pos.pool?.token0;
        const token1 = pos.pool?.token1;
        if (!token0 || !token1) {
            console.error('Invalid pool tokens');
            exit();
        }
        const d0 = parseInt(token0.decimals, 10);
        const d1 = parseInt(token1.decimals, 10);
        const sym0 = token0.symbol.toUpperCase();
        const sym1 = token1.symbol.toUpperCase();
        const amount0 = parseFloat(formatUnits(amount0Raw, isNaN(d0) ? 18 : d0));
        const amount1 = parseFloat(formatUnits(amount1Raw, isNaN(d1) ? 18 : d1));
        let feesETH = 0,
            feesUSDC = 0;
        if (sym0 === 'USDC') feesUSDC += amount0;
        if (sym1 === 'USDC') feesUSDC += amount1;
        if (sym0 === 'WETH' || sym0 === 'ETH') feesETH += amount0;
        if (sym1 === 'WETH' || sym1 === 'ETH') feesETH += amount1;
        owedETH = feesETH;
        owedUSDC = feesUSDC;
        owedUSD = feesUSDC + feesETH * ethPrice;
        console.log('Fees calculated: ETH:', owedETH, 'USDC:', owedUSDC, 'USD:', owedUSD);
        console.log('Loading state');
        const st = loadState();
        const prev = st[tokenId] || { owedUSD: 0 };
        deltaUSD = Math.max(0, owedUSD - (prev.owedUSD || 0));
        st[tokenId] = { date: nowISO, owedUSD, owedETH, owedUSDC };
        console.log('Saving state');
        saveState(st);
    }
    let status = 'OK';
    if (healthFactor < 1.5) status = 'ALERT';
    else if (healthFactor < 1.8) status = 'WARNING';
    console.log('Performing DNS lookup for SMTP host');
    dns.lookup(process.env.SMTP_HOST as string, (err, address) => {
        if (err) console.error('DNS lookup error:', err);
        else console.log('SMTP host resolved to:', address);
    });
    console.log('Creating email transporter');
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD,
        },
        debug: true,
        logger: true,
        tls: {
            rejectUnauthorized: false,
        },
    });
    console.log('Verifying transporter connection');
    try {
        await transporter.verify();
        console.log('Transporter connection verified');
    } catch (err) {
        console.error('Transporter verification failed:', err);
        throw err;
    }
    const subject = `Aave/Uniswap Daily — HF: ${fmt(healthFactor, 2)} (${status}), 24h fees: $${fmt(deltaUSD, 2)}`;
    const body = `Привет! Ежедневный отчёт по позиции (Arbitrum).
[Aave V3]
- Health Factor: ${fmt(healthFactor, 2)} [${status}]
- Collateral: $${fmt(collateral, 2)}
- Debt: $${fmt(debt, 2)}
- LTV: ${fmt(ltv * 100, 2)}%
- Запас до порога ликвидации: ${fmt(bufferToLiq * 100, 2)}%
[Uniswap v3 — ETH/USDC 0.05%]
- tokenId: ${tokenId || 'не найдено'}
- Накопленные комиссии на сейчас:
   • ETH: ${fmt(owedETH, 6)}
   • USDC: ${fmt(owedUSDC, 2)}
   • Итого: ~$${fmt(owedUSD, 2)}
- Доход за последние 24ч: ~$${fmt(deltaUSD, 2)}
Дата: ${nowISO}
`;
    console.log('Sending email', body);
    const info = await transporter.sendMail({
        from: process.env.SMTP_FROM_ADDRESS,
        to: process.env.SMTP_TO_ADDRESS,
        subject,
        text: body,
    });
    console.log('Report sent:', info.messageId);
};
main().catch((e) => {
    console.error('Error in main:', e);
    process.exit(1);
});
