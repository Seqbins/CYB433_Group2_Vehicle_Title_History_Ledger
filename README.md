# CYB433 Group 2 – Vehicle Title & History Ledger

`contracts/VehicleHistory.sol` records **vehicle registration, mileage, maintenance, accidents, ownership transfers and status** on Ethereum. Odometer rollback is rejected on-chain, and accident history stays with the car through every sale.

## Team

| Name | Student ID | Main contribution |
|------|-----------|-------------------|
| _خالد مبارك_ | _4401950_ | _e.g. contract design, gas optimization_ |
| _زايد عمر_ | _4401542_ | _e.g. Slither audit and refactor, deployment_ |
| _فهد القاضي_ | _4403325_ | _e.g. test suite and coverage, report_ |

## Deployment (Sepolia)

| | |
|---|---|
| Contract address | `0xF62d944aEda9CF600A53E1fAc0e689A40D89dBFB` |
| Etherscan (verified) | [https://sepolia.etherscan.io/address/0xF62d944aEda9CF600A53E1fAc0e689A40D89dBFB#code](https://sepolia.etherscan.io/address/0xF62d944aEda9CF600A53E1fAc0e689A40D89dBFB#code) |
| Constructor argument | `maxKmPerDay = 2000` |

## How to run

```bash
npm install
npm test                 # 38 Mocha/Chai tests on the local Hardhat network
npm run coverage         # 100 % statements, branches, functions and lines
npm run gas              # gas report (REPORT_GAS=true npx hardhat test)
npm run gas:bench        # fixed-scenario gas benchmark used in the report
slither .                # static analysis (pip install slither-analyzer)
```

### Sepolia

1. `cp .env.example .env` and fill in `SEPOLIA_RPC_URL`, `PRIVATE_KEY` (a **new course-only** wallet funded from a Sepolia faucet) and `ETHERSCAN_API_KEY`.
2. `npm run deploy:sepolia` prints the address and deploy tx hash and saves `deployments/sepolia.json`.
3. `npx hardhat verify --network sepolia <ADDRESS> 2000` (green check mark on Etherscan).
4. `npm run interact:sepolia` sends 5 live write transactions: `setInspector`, `setServiceCenter`, `registerVehicle`, `recordMaintenance` and `recordAccident`.

`.env` is listed in `.gitignore`; keys are only read through `process.env` in `hardhat.config.js`.

## Repository layout

```
contracts/VehicleHistory.sol        final contract
test/VehicleHistory.test.js         38 tests
scripts/deploy.js                   deployment
scripts/interact.js                 live write transactions
scripts/gas-benchmark.js            fixed-scenario gas measurement
audit/slither-initial.txt           Slither on the original contract
audit/slither-final.txt             Slither on the final contract
gas/gas-before.txt  gas/gas-after.txt
docs/baseline/                      original contract + its 33-test suite (the "before" version)
```