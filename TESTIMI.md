# Bound — udhëzuesi i testimit

Sistemi v0.1 është i ndërtuar, i rregulluar pas dy auditimeve dhe i testuar automatikisht. Mbetet vetëm testimi me wallet-in tënd: fillimisht falas në devnet, pastaj një swap i vogël real në mainnet.

## Çfarë është testuar tashmë automatikisht

| Testi | Rezultati |
| --- | --- |
| Verifier-i: raste të ndershme në v0 dhe v1, 16 mutacionet M1–M16 dhe sulme të tjera | 39/39 |
| Gjetjet e auditimit të parë B-01 deri B-12 dhe C-05: një test për secilën, në vend të PoC-ve të auditorit | 35/35 |
| Kthimi nga wallet-i (R6) dhe arkitektura (verifier-i paketë e pavarur, kufijtë nga `constants.ts`) | 6/6 dhe 3/3 |
| Certifikata e çdo transaksioni të verifikuar (debiti, fee, minimumi, SHA-256 i mesazhit) | 6/6 |
| Serveri: kill switch, çelësi i klientit vetëm nga header-i i konfiguruar, metodat RPC, `payer`, madhësia në bajte, timeout-et, proxy-ja e ikonave | 22/22 |
| Përgjigjet e Jupiter-it: një quote i keqformuar refuzohet me gabim të qartë | 9/9 |
| Auditimi i dytë, mbi pipeline-in real me Jupiter armiqësor: decimals nga Solana (C-01), minimumi i llogaritur nga Bound dhe ai i pranuar nga klienti (C-02), fee e rrjetit, qiraja, njoftimi për delegate, refuzimet e përkohshme të Jupiter-it, certifikata dhe kohët | 13/13 |
| Dërgimi (C-03): "No funds moved" vetëm kur rrjeti e provon; përndryshe "kontrollo Solscan" | 11/11 |
| Zgjedhja e route-it: një route me mbi 64 llogari anashkalohet dhe kërkohet një më i vogël | 3/3 |
| Property tests (fast-check): variacione të ndershme pranohen, sulme të rastësishme refuzohen | 20,000 raste për secilën veti, pas rregullimeve të auditimit të dytë |
| T4 në mainnet: Jupiter → compiler → simulim → verifier, 30 çifte × v0 dhe v1, me fee-n e Bound | 60/60 |
| T1 në mainnet: 8 sulme me SPL Token dhe System Program realë | 8/8 sillen siç pritet, verifier-i i refuzon të gjitha |
| T5 në mainnet: minimumi i daljes (nëse swap-i jep më pak, i gjithë transaksioni anulohet) | 3/3 |
| T6: një program keqdashës i vërtetë në vendin e Jupiter-it, i ekzekutuar në një makinë virtuale Solana | 17/17 |
| T7: shuma në rritje deri në rreth $10M (nuk ka limit shume) | 14/15; refuzohet vetëm një route BONK prej $1M që nuk nxë në një transaksion |
| E2E në Edge me wallet testimi: quote, ndërtim, verifikim, R6 ndalon kthimin e panënshkruar, CSP me nonce, ikonat vetëm nga Bound, Jupiter nuk merr adresën e wallet-it, ngjitja e adresës së coin-it | 17/17 |

## Para se të fillosh

1. Hap PowerShell në folderin e projektit dhe instalo varësitë (vetëm herën e parë):

```powershell
cd "C:\Users\Perdorues\Desktop\orientim cr\bound"
npm install
```

2. Përdor një **wallet testimi** në Phantom, kurrë wallet-in kryesor.

## Testi 1: falas në devnet (sjellja e Phantom-it)

Ky test tregon si sillet Phantom me nënshkruesin e dytë (E). Nuk kushton asgjë.

1. Në Phantom: Settings → Developer Settings → Testnet Mode → **Solana Devnet**.
2. Merr SOL devnet falas te https://faucet.solana.com (me adresën e wallet-it të testimit).
3. Nis faqen e testit:

```powershell
cd "C:\Users\Perdorues\Desktop\orientim cr\bound\spikes\wallet-test"
npm install
npm run dev
```

4. Hap http://localhost:5173/devnet.html, kliko Phantom, pastaj:
   - **Ndërto dhe simulo** → duhet të shfaqet "simulimi kaloi";
   - **Nënshkruaj me wallet** → shiko dritaren e Phantom-it dhe bëj një screenshot;
   - **E nënshkruan dhe dërgo** → duhet të shfaqet "U konfirmua në devnet".
5. Ndale serverin me `Ctrl+C` dhe ktheje Phantom-in te **Mainnet**.

## Testi 2: swap real në mainnet me dApp-in

Kostoja reale: disa cent (fee e rrjetit). 1 USDC kthehet në SOL që mbetet i yti. Në test mode nuk paguhet fee e Bound.

1. Në wallet-in e testimit duhen **~0.02 SOL** dhe **~2 USDC** në rrjetin Solana.
2. Ndërto dhe nis dApp-in:

```powershell
cd "C:\Users\Perdorues\Desktop\orientim cr\bound"
npm run build
npm run start -w @bound/web
```

3. Hap http://localhost:3000 dhe kliko **Connect wallet** → Phantom.
4. Shkruaj **1** USDC → SOL. Nën "You receive" duhet të shfaqet **Minimum received … · checked by Bound**.
5. Kliko **Protected swap**. Ndërsa hapet Phantom, faqja shfaq minimumin e saktë që do të kontrollohet, fee-n e saktë të rrjetit dhe **Bound certificate** (hape për të parë debitin e aprovuar, fee-n, minimumin dhe "Other assets debited: None"). Nëse çmimi ka lëvizur më shumë se 0.5% që kur e pe, faqja të pyet para se të hapet Phantom-i: **Continue with the new minimum** ose **Cancel**.
6. Në dritaren e Phantom-it kontrollo:
   - −1 USDC dhe +SOL;
   - që nuk ka asnjë ndryshim tjetër në asetet e tua;
   - çfarë paralajmërimi shfaq (screenshot).
7. Aprovo. Duhet të dalë "Swapped 1 USDC for ~… SOL" me lidhjen për Solscan.
8. Në Solscan hap transaksionin dhe kontrollo që te instruction-i i **Jupiter** nuk shfaqet adresa e wallet-it tënd.
9. Provo edhe **SOL → USDC** (0.005 SOL) dhe një memecoin, p.sh. **USDC → BONK** (1 USDC). Nëse nuk ke pasur kurrë BONK, faqja shfaq rreshtin **New BONK account: 0.00148844 SOL, one time, stays yours** (shuma vjen nga Solana). Kjo është depozita që Solana mban në llogarinë tënde të re dhe mbetet e jotja.
10. Provo edhe ngjitjen e adresës së një coin-i te kërkimi. Nëse Jupiter nuk e njeh, faqja e lexon nga Solana dhe e shënon "Not listed on Jupiter".
11. Te "Your recent swaps" çdo swap shfaqet si **pending** sapo nisesh dhe pastaj merr statusin përfundimtar. Nëse shfaqet **check Solscan**, rezultati nuk dihej ende; hape lidhjen para se të provosh përsëri.

## Testi 3: Solflare dhe Backpack

Nëse i ke, përsërit Testin 2 me secilin wallet.

## Çfarë duhet të më dërgosh

- Versionet që shfaq çdo wallet te lista e wallet-eve (p.sh. `legacy, 0`).
- Screenshot-et e dritares së wallet-it (devnet dhe mainnet).
- Lidhjet e Solscan për çdo swap.
- Çdo mesazh gabimi që shfaq faqja, me tekstin e plotë.

## Para publikimit

Krijo `apps\web\.env.local` nga `apps\web\.env.example` dhe plotëso:

- `NEXT_PUBLIC_BOUND_TREASURY`: wallet-i që merr fee-n 0.5% (pa të, faqja është në test mode). Ky vlerë futet në faqe gjatë `npm run build`, prandaj pas çdo ndryshimi duhet build i ri. Serveri nuk mund ta ndryshojë më vonë.
- `NEXT_PUBLIC_BOUND_FEE_BPS`: 50 (0.5%). Verifier-i refuzon çdo gjë mbi 1%.
- `RPC_URL`: një RPC me pagesë (Helius, Triton ose QuickNode).
- `JUPITER_API_KEY`: key falas nga https://developers.jup.ag/portal.

**Llogaritë e treasury-t.** Bound nuk e bën më përdoruesin të paguajë qiranë e llogarisë së fee-së. Nëse treasury nuk ka llogari për tokenin që paguan përdoruesi, ai swap bëhet pa fee. Prandaj krijo një herë llogaritë e treasury-t për tokenët kryesorë (USDC, USDT, JUP, BONK, WIF etj.). Mënyra më e thjeshtë: nga një wallet tjetër dërgo një sasi shumë të vogël të secilit token te adresa e treasury-t. Wallet-i krijon llogarinë automatikisht dhe ti paguan ~0.002 SOL për secilin token. Për SOL nuk duhet asgjë.

- **Treasury:** mbaje çelësin në një hardware wallet ose në një multisig (p.sh. Squads). Serverit i jepet vetëm adresa.
- **Publikimi:** build-i bëhet nga një tag i nënshkruar në GitHub dhe publikohet hash-i i build-it, që çdokush të kontrollojë se faqja është ajo e audituar.
- `BOUND_CLIENT_IP_HEADER`: në Vercel lëre `x-vercel-forwarded-for`; prapa Cloudflare vendos `cf-connecting-ip`. Në Vercel shto edhe një rregull "rate limit" te Firewall, sepse limiti i aplikacionit vlen vetëm për një instancë.

Çelësi i ndalimit: `BOUND_DISABLED=1` bën që serveri të refuzojë çdo swap të ri. Faqja e vjetër e hapur nuk mund ta anashkalojë, sepse ndalimi zbatohet te serveri.

## Nëse diçka shkon keq

Asnjë fond nuk humbet nga një gabim i Bound: ose transaksioni nuk nënshkruhet fare, ose ekzekutohet i tëri, ose anulohet i tëri. Nëse swap-i jep më pak se minimumi, anulohet i tëri. I vetmi kosto e mundshme është fee e rrjetit, nëse një transaksion i dërguar dështon on-chain. Nëse faqja thotë "We couldn't confirm the result yet", mos e përsërit swap-in pa e parë lidhjen në Solscan: transaksioni mund të ketë kaluar.
