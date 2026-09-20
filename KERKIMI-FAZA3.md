# Kërkimi para fazës 3: Token-2022 dhe Pump.fun

Shkruar më 2026-09-20, para se të ndërtohet asgjë. Të gjitha numrat janë matur nga mainnet-i dhe
nga API-t publike po atë ditë, jo të marra nga dokumentacioni.

---

## 1. Përse ky kërkim ndryshon planin

Ne e kishim ndarë punën në dy pjesë: "Token-2022" dhe "tokenat vetëm në Pump.fun". Matja tregon se
janë e njëjta punë:

- **Nga 100 tokenat me volum më të madh 24-orësh, 55 janë Token-2022** — 341 milionë dollarë nga
  817 milionë gjithsej, pra 42% e volumit.
- **Nga 30 tokenat më të rinj në Jupiter, 30 janë Token-2022.** Pump.fun sot i krijon tokenat me
  Token-2022, jo me SPL klasik.

Domethënë arsyeja e vërtetë pse tokenat e Pump.fun nuk punojnë te ne nuk është përjashtimi i
Pump.fun AMM, por rregulli R7 që pranon vetëm SPL klasik. **Mbështetja e Token-2022 është çelësi;
Pump.fun është një problem më i vogël dhe i ndarë.**

---

## 2. Si funksionon Token-2022

Është një program i dytë tokenash (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), me të njëjtat
instruksione si SPL klasik plus "extensions": copa të dhënash që i shtohen mint-it ose llogarisë dhe
që ndryshojnë sjelljen. Një token mund të ketë disa njëherësh.

Këto i pamë në tokenat realë me volum:

| Extension | Çfarë bën | Rreziku për ne |
| --- | --- | --- |
| MetadataPointer, TokenMetadata | emri, simboli, ikona brenda mint-it | asnjë |
| GroupPointer, Group, Member | grupime tokenash | asnjë |
| TransferFeeConfig | mban një përqindje nga çdo transfertë, e ndalur te llogaria marrëse | e prek koston, jo sigurinë (pika 3) |
| TransferHook | thërret një program të zgjedhur nga mint-i te çdo transfertë | kod i huaj brenda transfertës |
| PermanentDelegate | një adresë mund të lëvizë tokenat e kujtdo, përgjithmonë | shkel garancinë tonë |
| DefaultAccountState | llogaritë e reja lindin të ngrira derisa t'i lirojë emetuesi | llogaria jonë e përkohshme lind e ngrirë |
| Pausable | emetuesi ndal çdo transfertë | transaksioni dështon, pa humbje |
| NonTransferable | tokeni nuk lëviz fare | s'ka swap |
| ScaledUiAmount, InterestBearing | shumëzues për shfaqjen; balanca e vërtetë mbetet e njëjtë | numri që shohim ne ndryshon nga ai i wallet-it |
| ConfidentialTransfer | transferta të fshehura si mundësi shtesë | transfertat tona të zakonshme punojnë normalisht |
| ImmutableOwner, CpiGuard, MemoTransfer | mbrojtje të vetë llogarisë | ImmutableOwner s'na pengon; MemoTransfer kërkon memo te çdo hyrje |

### Çfarë kanë realisht tokenat me volum

- **Shumica dërrmuese e memecoin-eve** (CATE $29M, PAID $19M, TIPPED $15M, FLEX, JEANPHIL…):
  vetëm metadata. **Këta punojnë me një ndryshim të thjeshtë.**
- **PUMP ($26M/ditë)**: ka TransferHook, por programi i hook-ut është `11111…111`, domethënë
  **asnjë program nuk thirret**. Kontrolli ynë ekzistues `riskyMintExtension` e trajton saktë si "pa
  hook", sepse i lexon 32 bajtët e program-id dhe i sheh zero.
- **Aksionet e tokenizuara (SPYx, NVDAx, GLDx, MSFTx, BABA, RBLX…)**: PermanentDelegate +
  DefaultAccountState + Pausable + ScaledUiAmount. Këta **nuk mbështeten dhe nuk duhen mbështetur**:
  llogaria jonë e përkohshme do të lindte e ngrirë, dhe emetuesi mund t'i lëvizë tokenat e kujtdo.
- **Tokena me tarifë transferimi** (FEELSGOOD 3%, WOW 3%, ZCAT 3%, ALLINU 1%, GP 3%…): rreth
  40 milionë dollarë volum në ditë. Kërkojnë dy vendime të vogla (pika 3).

---

## 3. Tarifa e transferimit: çfarë matëm vetë

Dy pyetje ishin vendimtare, sepse kontrolli ynë i minimumit është një self-transfer dhe pastrimi ynë
mbyll llogari.

**A e ha tarifa kontrollin tonë të minimumit?** Jo. Simuluam në mainnet një self-transfer të gjysmës
së balancës në FEELSGOOD, që ka tarifë aktive 3%: transferta kaloi dhe balanca nuk ndryshoi aspak.
Token-2022 nuk e llogarit tarifën kur burimi dhe destinacioni janë e njëjta llogari. Kontrolli ynë i
minimumit funksionon njësoj te këta tokena.

**A mbyllet llogaria e përkohshme?** Jo pa një hap shtesë. Tarifa ndalet te llogaria **marrëse**, dhe
një llogari me tarifë të ndalur nuk mbyllet: programi kthen `AccountHasWithheldTransferFees`. Pra
pas swap-it, `CloseAccount(E_in)` do të dështonte dhe i gjithë transaksioni do të anulohej.
Zgjidhja është një instruksion i vetëm, që mund ta thërrasë kushdo:
`HarvestWithheldTokensToMint(mint, [E_in])` para mbylljes. E shtojmë te instruksionet tona të
besuara dhe te rregullat e verifier-it.

**Kostoja për klientin.** Tarifa paguhet për çdo transfertë. Një swap normal bën një transfertë nga
wallet-i te pool-i. Ne bëjmë dy: wallet → llogaria e përkohshme, pastaj llogaria e përkohshme →
pool. Pra **te një token me tarifë 3% si input, klienti paguan rreth 3% më shumë me Bound sesa pa
të**. Si output nuk ka kosto shtesë, sepse dalja shkon drejt e te llogaria e klientit.

Kjo është një kosto reale që duhet vendosur: ta ndalojmë si input, apo ta lejojmë me paralajmërim të
qartë ("ky token mban 3% për çdo transfertë; mbrojtja shton një transfertë, pra e paguan dy herë")?

---

## 4. Pump.fun

Janë dy programe të ndryshme, dhe Jupiter i quan me dy emra:

- **`Pump.fun`** — kurba e lidhjes (bonding curve), ku tregtohet një token i ri para "diplomimit".
  Ne **nuk e përjashtojmë**.
- **`Pump.fun Amm`** (PumpSwap) — pool-i pas diplomimit. Ne **e përjashtojmë** (D13).

**Sa kushton përjashtimi.** E matëm në tokena që kanë të dyja rrugët: PAID 0.07% më keq, CATE 0.50%,
JEANPHIL 3.18%. Pra për tokenat e mëdhenj përjashtimi nuk i bllokon, vetëm i shtrenjton, ndonjëherë
ndjeshëm.

**Pse nuk punojnë tokenat e rinj.** Në çdo route të Pump.fun (të dyja programet) ndodhet një llogari
`user_volume_accumulator`, një PDA e lidhur me **blerësin** — te ne, me çelësin e përkohshëm E. Për
tokenat e rinj ajo nuk ekziston dhe duhet krijuar brenda swap-it, dhe qiranë e paguan nënshkruesi.
Te ne E nuk ka asnjë lamport, sepse me qëllim nuk i japim: kështu swap-i dështon në simulim, route-i
përjashtohet, dhe klienti sheh "nuk ka route të mbrojtur".

**Zgjidhja e mundshme.** Një instruksion i besuar që i dërgon E-së saktësisht aq lamport sa duhen për
qiratë që mungojnë, dhe në fund një i dytë që ia kthen W-së atë që mbetet (E nënshkruan gjithsesi).
Kjo nuk e prek garancinë: programi i jashtëm sheh vetëm E-në dhe shumën e aprovuar, dhe tani edhe një
sasi të vogël SOL të E-së, e cila kufizohet dhe i tregohet klientit. Qiraja që hyn te llogaria e
Pump.fun nuk kthehet kurrë — rreth 0.002 SOL për swap — sepse llogaria i mbetet një çelësi që ne e
hedhim.

Kjo kërkon: një rregull të ri te verifier-i (sa SOL mund të marrë E dhe kush ia kthen), llogaritjen e
saktë të qirave që mungojnë, shfaqjen e kostos para nënshkrimit, dhe teste. E rekomandoj **pas**
Token-2022, si punë më vete.

---

## 5. Çfarë duhet ndryshuar në kodin tonë

| Skedari | Ndryshimi |
| --- | --- |
| `core/types.ts`, `policy.ts` | politika mban programin e tokenit për input dhe output; `ataOf` thirret me programin e duhur |
| `core/compiler.ts` | krijimi i ATA-ve, TransferChecked, Revoke, CloseAccount dhe kontrolli i minimumit marrin programin e duhur; shtohet Harvest para mbylljes kur mint-i ka tarifë |
| `verifier/parse.ts` | njeh të njëjtat instruksione edhe nga Token-2022, plus Harvest |
| `verifier/verify.ts` | R7 zëvendësohet: në vend të "vetëm SPL klasik", një listë e lejuar extensionesh për mint-in hyrës dhe dalës; rregullat e reja për Harvest |
| `jupiter/swap.ts` | hiqet refuzimi te rreshti 220; qiraja llogaritet me madhësinë reale të llogarisë (Token-2022 me ImmutableOwner zë më shumë) |
| `apps/web` | hiqet bllokimi te faqja; paralajmërim për tarifën e transferimit; shfaqja e kostos shtesë |
| Testet | fixtures me mint Token-2022; raste T6 me tarifë dhe me hook keqdashës; çifte Token-2022 te testi i mainnet-it |

---

## 6. Çfarë propozoj të pranojmë dhe çfarë të refuzojmë

| Extension | Vendimi im | Pse |
| --- | --- | --- |
| Metadata, MetadataPointer, Group, Member | **pranohet** | nuk prek transfertat |
| ConfidentialTransfer (si mundësi) | **pranohet** | transfertat tona të hapura punojnë normalisht |
| TransferHook me program `11111…` | **pranohet** | nuk thirret asnjë kod; kjo mbulon PUMP-in |
| TransferFeeConfig | **pranohet me paralajmërim**, plus Harvest para mbylljes | kosto, jo rrezik; vendimi yt nëse e lejojmë si input |
| TransferHook me program real | **refuzohet tani** | kod i huaj brenda transfertës; kërkon test dhe mendimin e auditorit |
| PermanentDelegate | **refuzohet** | dikush tjetër mund t'i lëvizë tokenat e klientit |
| DefaultAccountState (i ngrirë) | **refuzohet** | llogaria jonë e përkohshme lind e ngrirë |
| NonTransferable | **refuzohet** | s'ka swap fare |
| Pausable | **refuzohet tani** | s'ka humbje, por shton një palë që mund ta ndalë swap-in |
| ScaledUiAmount, InterestBearing | **refuzohet tani** | do të shfaqnim numra të ndryshëm nga wallet-i |
| MemoTransfer te llogaria e klientit | **refuzohet tani** | çdo hyrje kërkon memo; do të na duhej një instruksion më shumë |

Me këtë listë mbulohen tokenat me metadata (shumica e volumit të memecoin-eve), PUMP, dhe — nëse e
vendos ti — tokenat me tarifë transferimi.

---

## 7. Radha e punës

> **Gjendja më 2026-09-20:** hapat 1 dhe 2 u kryen, plus pragjet e reja të çmimit (nën 1% vazhdon,
> 1-5% pyetet klienti, mbi 5% refuzohet). Tokenat me tarifë transferimi mbështeten: pastrimi bën
> `HarvestWithheldTokensToMint` para mbylljes, route-i kuotohet mbi shumën që arrin vërtet, dhe
> faqja e thotë hapur se tarifa paguhet dy herë dhe shkon te tokeni, jo te Bound. Hapi 1: Token-2022 pranohet me listën e lejuar të pikës 6,
> politika mban programin e çdo mint-i (i lexuar nga zinxhiri dhe i rikontrolluar nga verifier-i),
> dhe faqja nuk i bllokon më. Provuar: 12 teste njësie dhe 12/12 çifte reale në mainnet me PUMP,
> CATE, PAID dhe TIPPED, në v0 dhe v1. Hapat 2-4 mbeten.


1. **Token-2022 pa tarifë** (metadata, hook bosh): ndryshimet e tabelës së pikës 5, pa Harvest.
   Kjo hap PUMP-in dhe pothuajse të gjithë tokenat e rinj të Pump.fun që kanë dalë nga kurba.
2. **Tarifa e transferimit**: Harvest para mbylljes, paralajmërimi, testet.
3. **Testet e T6 me Token-2022**: një mint me tarifë dhe një hook keqdashës brenda makinës virtuale,
   për të parë se çfarë mund të bëjë vërtet një hook.
4. **Pump.fun me parafinancim të E-së**: punë më vete, pas mendimit të auditorit.

---

## 8. Vendimet që më duhen nga ti

1. **Tokenat me tarifë transferimi si input**: t'i lejojmë me paralajmërim ("e paguan tarifën dy
   herë"), apo t'i ndalojmë? Si output nuk ka kosto shtesë në asnjë rast.
2. **Aksionet e tokenizuara** (SPYx e të ngjashëm): dakord që t'i lëmë jashtë përgjithmonë?
3. **Pump.fun me parafinancim**: e ndërtojmë pas Token-2022, apo e lëmë si kufi të njohur?
