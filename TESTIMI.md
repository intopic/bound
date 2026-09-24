# Bound — udhëzuesi i testimit

Sistemi v0.1 është i ndërtuar, i rregulluar pas disa auditimeve dhe i testuar automatikisht (numrat e fundit: `AUDIT.md`, seksionet 0u deri 0y). Mbeten testimi me wallet-in tënd (fillimisht falas në devnet, pastaj një swap i vogël real në mainnet) dhe Etapa 2 e auditimit të pavarur: rikuperimi me një RPC që gabon qëllimisht, portofolet reale dhe matjet. Tabela më poshtë është historike: disa numra janë nga datat e para.

## Çfarë është testuar tashmë automatikisht

| Testi | Rezultati |
| --- | --- |
| Verifier-i: raste të ndershme në v0 dhe v1, 16 mutacionet M1–M16 dhe sulme të tjera | 39/39 |
| Gjetjet e auditimit të parë B-01 deri B-12 dhe C-05: një test për secilën, në vend të PoC-ve të auditorit | 35/35 |
| Kthimi nga wallet-i (R6) dhe arkitektura (verifier-i paketë e pavarur, kufijtë nga `constants.ts`) | 6/6 dhe 3/3 |
| Certifikata e çdo transaksioni të verifikuar (debiti, fee, minimumi, SHA-256 i mesazhit) | 6/6 |
| Serveri: kill switch, marker-i i refuzimit lokal, çelësi i klientit vetëm nga header-i i konfiguruar, metodat RPC (përfshirë `getEpochInfo`), `payer`, madhësia në bajte, timeout-et, proxy-ja e ikonave | 23/23 |
| Përgjigjet e Jupiter-it: një quote i keqformuar refuzohet me gabim të qartë | 9/9 |
| Auditimi i dytë, mbi pipeline-in real me Jupiter armiqësor: decimals nga Solana (C-01), minimumi i llogaritur nga Bound dhe ai i pranuar nga klienti (C-02), fee e rrjetit, qiraja, njoftimi për delegate, refuzimet e përkohshme të Jupiter-it, certifikata dhe kohët | 13/13 |
| Dërgimi (C-03): preflight/refuzimi lokal ndahet nga gabimet e paqarta të RPC-së; përndryshe "kontrollo Solscan" | 13/13 |
| Rikthimi te swap-et e hapura dhe wallet chain: skadim vetëm me `lastValidBlockHeight`, entries e vjetra mbeten unknown, vetëm account `solana:mainnet` pranohet | 5/5 |
| Zgjedhja e route-it: një route me mbi 64 llogari anashkalohet dhe kërkohet një më i vogël | 3/3 |
| Property tests (fast-check): variacione të ndershme pranohen, sulme të rastësishme refuzohen | 20,000 raste për secilën veti, pas rregullimeve të auditimit të dytë |
| T4 në mainnet: Jupiter → compiler → simulim → verifier, 30 çifte × v0 dhe v1, me fee-n e Bound | 60/60 |
| T1 në mainnet: 8 sulme me SPL Token dhe System Program realë | 8/8 sillen siç pritet, verifier-i i refuzon të gjitha |
| T5 në mainnet: minimumi i daljes (nëse swap-i jep më pak, i gjithë transaksioni anulohet) | 3/3 |
| T6: një program keqdashës i vërtetë në vendin e Jupiter-it, i ekzekutuar kundër SPL klasik dhe Token-2022 në një makinë virtuale Solana | 32/32 |
| Token-2022: rregulli i extensions-ave dhe një swap i ndershëm me Token-2022 | 12 teste njësie + 12/12 çifte reale (PUMP, CATE, PAID, TIPPED) në mainnet |
| T7: shuma në rritje deri në rreth $10M (nuk ka limit shume) | 14/15; refuzohet vetëm një route BONK prej $1M që nuk nxë në një transaksion |
| T13: PumpSwap në mainnet, 5 tokenë të Pump.fun: blerje (me qiranë 0.0013 SOL që i jepet çelësit të përkohshëm) dhe shitje nga mbajtës realë; çelësi mbetet bosh (AUDIT.md 0k) | 45/45 |
| T14: bonding curve i Pump.fun në mainnet, 5 tokenë që s'kanë dalë ende nga kurba: blerje dhe shitje me tolerancë 3%; Pump.fun e zhbën vetë WSOL-in nga kutia e çelësit të përkohshëm; qiraja 0.0013–0.0015 SOL; çelësi mbetet bosh (AUDIT.md 0k) | 42/42 |
| Çmimi që lëviz gjatë simulimit: rikuotohet dhe tregu nuk përjashtohet, edhe kur çelësi është financuar me qiranë | 3/3 |
| Toleranca e çmimit: 3% vetëm kur route-i kalon vërtet nëpër programin e kurbës, 0.5% për çdo route tjetër (edhe PumpSwap), dhe Jupiter-it i kërkohet po ajo tolerancë; minimumi i pranuar nga klienti fiton kur është më i rreptë (BR-01, BR-04) | 7/7 |
| Recensioni v1 (AUDIT.md 0m): adresë e ngarkuar dy herë (BR-14), wallet pa SOL të mjaftueshëm (BR-10), tarifë SOL drejt treasury-t që s'ekziston (BR-06), paralajmërimet nga zinxhiri (BR-11), kyçi i swap-it (BR-02), v1 pas flamurit (BR-12), sasia e marrë nga transaksioni (BR-03) | 18/18 |
| Karta "Before your wallet opens" në Edge: blerje e një tokeni në kurbë tregon tarifën e tregut para se të hapet wallet-i, dhe wallet-i thirret një herë pasi klienti vazhdon | 5/5 |
| T12: stablecoin-ët me delegat të lëshuesit (PYUSD, USDG, AUSD, CASH) në mainnet: si hyrje dhe si dalje, llogaritë e përkohshme mbyllen, qiraja e shfaqur = qiraja e ngarkuar (AUDIT.md 0j) | 33/33 |
| Tokenët nëpër të cilët kalon route-i: një hop që ekzekuton kod refuzohet, një i pastër kalon (AUDIT.md 0i) | 4/4 |
| T11: çfarë shtojnë vërtet wallet-et, lexuar nga 90 transaksione reale në mainnet (AUDIT.md 0h) | asnjë handler kujtese, deri në 10 asertime, 0–1 llogari secila |
| Diagnostika e wallet-it: mesazh identik, shtesë në fund, shtesë në fillim, instruksionet tona të ndryshuara, nënshkrues i ri, raporti | 6/6 |
| E2E në Edge me wallet testimi: quote, ndërtim, verifikim, R6 ndalon kthimin e panënshkruar, CSP me nonce, ikonat vetëm nga Bound, Jupiter nuk merr adresën e wallet-it, ngjitja e adresës së coin-it, rreshti i vetëm i mbrojtjes | 17/18; kontrolli SRI (5 nga 8 skripte me hash) dështonte edhe para thjeshtimit të 23 shtatorit |

## Para se të fillosh

1. Hap PowerShell në folderin e projektit dhe instalo varësitë (vetëm herën e parë):

```powershell
cd "C:\Users\Perdorues\Desktop\orientim cr\bound"
npm install
```

2. Përdor një **wallet testimi** në Phantom, kurrë wallet-in kryesor.

## Testi 0: çfarë i bën wallet-i transaksionit (bëje këtë të parin)

Bound ka një premtim të vetëm: bajtët që verifikoi janë bajtët që ekzekutohen, dhe çdo gjë tjetër refuzohet. Phantom-i shkruan në dokumentacionin e vet se mund t'i shtojë transaksionit kontrollet e veta. Nëse e bën, rregulli ynë do ta refuzonte dhe swap-i do të dështonte pa asnjë arsye të vërtetë. Nëse nuk e bën, s'kemi pse të shkruajmë asnjë përjashtim. Askush nuk e di ende cila nga të dyja është e vërteta.

Kjo faqe e zgjidh pyetjen me fakte. **Nuk dërgon asgjë** — transaksioni nënshkruhet, lexohet dhe hidhet. Asnjë fond nuk lëviz.

1. Nis faqen:

```powershell
cd "C:\Users\Perdorues\Desktop\orientim cr\bound"
npm run dev
```

2. Hap http://localhost:3000/diagnostic
3. Lidh Phantom-in. Lëri mintet siç janë (SOL → USDC) dhe shumën `0.01`; wallet-i duhet të ketë aq SOL sa të ndërtohet route-i.
4. Shtyp **Build and ask the wallet to sign** dhe aprovo në Phantom.
5. Faqja të thotë njërën nga të dyja:
   - *The wallet changed nothing* — rregulli aktual qëndron dhe nuk ka punë tjetër për të bërë.
   - *The wallet changed the transaction* — poshtë saj shkruhet saktësisht çfarë shtoi, **ku** e shtoi (para apo pas instruksioneve tona), me cilat llogari, dhe a solli ndonjë nënshkrues të ri.
6. Shtyp **Copy the full report** dhe ma dërgo tekstin.
7. Përsërite me **v1** te "Transaction version", pastaj me Solflare dhe Backpack.
8. Ndale serverin me `Ctrl+C`.

Raporti është prova mbi të cilën shkruhet rregulli i pranimit. Pa të, çdo rregull për atë që pranojmë nga wallet-i është hamendje.

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
4. Shkruaj **1** USDC → SOL. Nën "You receive" duhet të shfaqet **Minimum output … · enforced on successful execution**.
5. Kliko **Protected swap**. Ndërsa hapet Phantom, faqja shfaq minimumin e saktë që do të kontrollohet dhe fee-n e saktë të rrjetit. Nëse çmimi ka lëvizur më shumë se toleranca (0.5%, ose 3% në bonding curve) që kur e pe, faqja të pyet para se të hapet Phantom-i: **Continue with the new minimum** ose **Cancel**.
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

- `NEXT_PUBLIC_BOUND_TREASURY`: wallet-i që merr fee-n 0.3% (pa të, faqja është në test mode). Ky vlerë futet në faqe gjatë `npm run build`, prandaj pas çdo ndryshimi duhet build i ri. Serveri nuk mund ta ndryshojë më vonë.
- `NEXT_PUBLIC_BOUND_FEE_BPS`: 30 (0.3%). Verifier-i refuzon çdo gjë mbi 1%.
- `RPC_URL`: Helius (ose një ofrues tjetër me pagesë). Nyja publike nuk mjafton: të kufizon shpejt dhe nuk pranon dërgime nga një faqe web.
- `JUPITER_API_KEY`: key falas nga https://developers.jup.ag/portal. **I domosdoshëm**: pa të, Jupiter i refuzon kërkesat pas një ose dy, dhe faqja shfaq "busy". Vendose edhe para testit me wallet.

**Llogaritë e treasury-t.** Bound nuk e bën më përdoruesin të paguajë qiranë e llogarisë së fee-së. Nëse treasury nuk ka llogari për tokenin që paguan përdoruesi, ai swap bëhet pa fee. Prandaj krijo një herë llogaritë e treasury-t për tokenët kryesorë (USDC, USDT, JUP, BONK, WIF etj.). Mënyra më e thjeshtë: nga një wallet tjetër dërgo një sasi shumë të vogël të secilit token te adresa e treasury-t. Wallet-i krijon llogarinë automatikisht dhe ti paguan ~0.002 SOL për secilin token. Për SOL nuk duhet asgjë.

- **Treasury:** mbaje çelësin në një hardware wallet ose në një multisig (p.sh. Squads). Serverit i jepet vetëm adresa.
- **Publikimi:** build-i bëhet nga një tag i nënshkruar në GitHub dhe publikohet hash-i i build-it, që çdokush të kontrollojë se faqja është ajo e audituar.
- `BOUND_CLIENT_IP_HEADER`: në Vercel lëre `x-vercel-forwarded-for`; prapa Cloudflare vendos `cf-connecting-ip`. Në Vercel shto edhe një rregull "rate limit" te Firewall, sepse limiti i aplikacionit vlen vetëm për një instancë.

Çelësi i ndalimit: `BOUND_DISABLED=1` bën që serveri të refuzojë çdo swap të ri. Faqja e vjetër e hapur nuk mund ta anashkalojë, sepse ndalimi zbatohet te serveri.

## Nëse diçka shkon keq

Asnjë fond nuk humbet nga një gabim i Bound: ose transaksioni nuk nënshkruhet fare, ose ekzekutohet i tëri, ose anulohet i tëri. Nëse swap-i jep më pak se minimumi, anulohet i tëri. I vetmi kosto e mundshme është fee e rrjetit, nëse një transaksion i dërguar dështon on-chain. Nëse faqja thotë "We couldn't confirm the result yet", mos e përsërit swap-in pa e parë lidhjen në Solscan: transaksioni mund të ketë kaluar.
