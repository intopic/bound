# Kërkim i thellë në ekosistem: çfarë bëmë mirë, çfarë duhet ndryshuar

Shkruar më 2026-09-20, pas një studimi të Jupiter-it, wallet-eve, agjentëve dhe mekanizmave të
mbrojtjes në Solana. Çdo pikë ka burimin dhe një vendim të propozuar.

---

## 1. Gjetja që prek ekzistencën: wallet-et e ndryshojnë transaksionin

Dizajni ynë kërkon që wallet-i ta kthejë mesazhin **bajt për bajt të njëjtë**, sepse çelësi i
përkohshëm nënshkruan i fundit mbi të njëjtat bajte. Rregulli R6 e refuzon çdo ndryshim.

Por praktika e ekosistemit ka ecur në drejtim tjetër:

- **Phantom shton "guard instructions"** (Lighthouse) te transaksionet që i dërgohen, për të
  garantuar që parashikimi që sheh përdoruesi përputhet me rezultatin real
  ([dokumentacioni i Phantom](https://docs.phantom.com/developer-powertools/lighthouse)).
- I njëjti model po përdoret edhe nga relay-t: Kora, implementimi i Solana Foundation, **shton një
  assertion mbi balancën e fee payer-it te `signTransaction`**, dhe u desh një fushë e re në
  përgjigje (`lighthouse_assertion_added`) sepse një bashkë-nënshkrues nuk e merrte vesh ndryshe se
  mesazhi kishte ndryshuar ([PR 675](https://github.com/solana-foundation/kora/pull/675)).
- Për rastet me dy nënshkrues, Phantom e quan të mbështetur **vetëm** rrugën ku aplikacioni
  nënshkruan **pasi** wallet-i e ka ndërtuar dhe validuar transaksionin, përmes një callback-u
  `presignTransaction` ([Phantom SDK](https://docs.phantom.com/sdks/browser-sdk/sign-and-send-transaction)).
- **Wallet-et e integruara (embedded) nuk e mbështesin fare `signTransaction`** — vetëm
  `signAndSendTransaction`. Pra për ta, Bound sot nuk funksionon aspak.

**Çfarë do të thotë për ne.** Kodi ynë sillet i sigurt: refuzon dhe nuk dërgon asgjë. Por swap-i
dështon. Nëse Phantom e shton atë instruksion te `signTransaction`, **çdo swap përmes Phantom-it
ndalet**. Kjo nuk është më hipotezë; është modeli drejt të cilit po shkon ekosistemi.

**Vendimi i propozuar, i korrigjuar pas rishikimit.** Formulimi i parë ishte "çdo assertion i një
programi të njohur, pa llogari të shkrueshme". Ai ishte tepër i gjerë, dhe për një arsye më të
mprehtë nga sa u tha në rishikim: **privilegjet në Solana janë të nivelit të transaksionit, jo të
instruksionit.** W është nënshkrues sepse paguan fee-n, pra çdo instruksion i shtuar mund ta
përdorë si nënshkrues. Dhe W është gjithmonë i shkrueshëm — domethënë rregulli im do ta kishte
refuzuar pikërisht assertion-in mbi balancën e fee payer-it, atë që duhet të pranojmë.

Rregulli i saktë është shumë më i ngushtë:

- program id-ja **saktësisht** e Lighthouse;
- të dhënat dekodohen në një **variant assertion-i të njohur**, nga një listë e mbyllur;
- llogaritë e përmendura kufizohen te një grup i pritur;
- asnjë nënshkrues i ri;
- dhe të 7 rregullat rikontrollohen mbi **mesazhin e kthyer**, jo mbi tonin, me ALT-të e zgjidhura
  sërish.

Rishikimi shtoi një shqetësim të drejtë: siguria varet edhe nga upgrade authority e Lighthouse.
**E kontrolluam në zinxhir:** programi `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` është
**i pandryshueshëm** — programdata `CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c`, vendosur te slot
294179293, pa upgrade authority. Pra kodi që pranojmë sot nuk mund të zëvendësohet nesër.

**Rruga e dytë: `presignTransaction`** për wallet-et e integruara. Aty Phantom ndërton dhe validon,
na jep mesazhin final, ne e verifikojmë dhe e nënshkruajmë brenda callback-ut, dhe Phantom shton
firmën e W-së dhe e dërgon. E nënshkruan i fundit? Jo — por garancia qëndron: çdo ndryshim pas
firmës së E-së do ta bënte atë firmë të pavlefshme.

Një pasojë që duhet mbajtur mend: në atë rrugë **dërgimin e bën Phantom**, jo ne. Raportimi ynë i
ndershëm i rezultatit ("asgjë nuk lëvizi", "skadoi", "e panjohur") mbështetet sot te fakti që
dërgimin e kontrollojmë ne. Për wallet-et e integruara ai tekst duhet ndryshuar, ose do të
pretendonim diçka që nuk e shohim dot.

Kjo është ndryshimi më i rëndësishëm që kemi përpara, dhe duhet parë nga auditori para zbatimit.

---

## 2. Gjetja që i sjell vlerë të madhe klientit: mbrojtja nga sandwich

Swap-et tona dërgohen si transaksione publike. Një bot mund të blejë para klientit dhe të shesë pas
tij, brenda tolerancës 0.5%. Minimumi ynë e kufizon humbjen, por nuk e parandalon.

Standardi i sotëm është **Jito**: rreth 95% e stake-ut ekzekuton klientin Jito, dhe transaksionet e
dërguara përmes tij mbeten të padukshme derisa të shkruhen në bllok
([Solana docs](https://solana.com/docs/defi/mev-protection),
[DL News](https://www.dlnews.com/articles/defi/solana-users-use-jito-to-stop-sandwich-attacks-and-mev/)).
Mekanizmi më i thjeshtë quhet **DontFront**: shtohet një llogari e lexueshme me adresë që fillon me
`jitodontfront…`, dhe transaksioni dërgohet te block engine-i i Jito-s në vend të RPC-së së
zakonshme. Kostoja: një bakshish rreth 0.04 dollarë.

Dhe Jupiter-i tashmë e mbështet nga ana e tij: endpoint-i `/swap/v2/build` pranon `tipAmount` dhe
`forJitoBundle`, dhe kthen një `tipInstruction` të veçantë ([Jupiter API v2](https://developers.jup.ag/docs/api-reference/swap/v2/build)).

**Sa vlen.** Për një swap prej 100 mijë dollarësh, një sandwich brenda tolerancës sonë kushton deri
në 500 dollarë. Fee-ja jonë për atë swap është 300. Domethënë kjo mbrojtje vlen **më shumë se sa
paguhemi ne**.

**Vendimi i propozuar, i korrigjuar pas rishikimit.** Kishte një gabim në formulimin e parë:
"dërgimi te block engine-i me kthim te RPC-ja normale nëse dështon". Një kthim i heshtur te rruga
normale do të thoshte t'i tregonim klientit "i mbrojtur nga MEV" ndërsa transaksioni del pikërisht
aty ku bot-et e shohin. Kjo nuk bëhet.

Dy mënyra, të zgjedhura para nisjes:

- **E detyruar:** nëse Jito nuk e pranon, transaksioni **nuk dërgohet**.
- **Sa të mundet:** kthimi te rruga normale lejohet vetëm nëse klienti (ose politika e një agjenti)
  e ka pranuar paraprakisht.

Dhe bakshishi nuk është konstant: minimumi është 1000 lamports, por vlera konkurruese ndryshon me
ngarkesën. Duhet një dysheme dinamike me tavan të fiksuar, vetëm adresat zyrtare të tip accounts,
dhe bakshishi brenda **të njëjtit transaksion** që të mos paguhet kur swap-i dështon.

Një saktësim i numrave: 0.5% është **maksimumi teorik** i asaj që mund të marrë një sandwich, jo
vlera e pritshme. Një bot merr aq sa i del fitimprurëse, dhe vetëm te tregtitë që lëvizin çmimin
ndjeshëm.

Rregulli i ri te verifier-i: saktësisht një transfertë bakshishi W → një adresë zyrtare Jito, nën
tavan, e llogaritur brenda kufirit të fee-së së rrjetit (R4), plus llogaria `jitodontfront` si e
lexueshme.

---

## 3. Kufiri i 64 llogarive: e konfirmuam, dhe ka një zgjidhje të pjesshme

Kufiri prej 64 llogarive është **kufi i runtime-it** (`MAX_TX_ACCOUNT_LOCKS`), jo i formatit.
Tabelat e adresave kursejnë **bajte**, jo llogari, pra nuk e zgjidhin problemin. Transaksionet v1,
aktive nga 15 shtatori, i heqin fare tabelat dhe arrijnë të njëjtat 64 llogari me adresa të plota
([Solana](https://solana.com/news/transaction-v1-and-the-alt-trade-off)).

Një propozim draft, **SIMD-0596**, do ta ngrinte kufirin në 96. Nuk është zbatuar ende.

Dy gjëra praktike për ne:

- **Instruksionet tona hanë rreth 12 nga 64 llogaritë.** Çdo llogari që kursejmë i shkon route-it.
- **Kur route-i nuk nxë vetëm për shkak të llogarisë sonë të fee-së**, mund ta ofrojmë swap-in
  **pa fee** në vend që ta refuzojmë. Klienti e merr swap-in, ne humbasim 0.3% — më mirë se një
  refuzim. Kjo është një zgjedhje produkti që ia vlen të matet.

Ky kufi konfirmon edhe diçka që e kemi bërë mirë: nuk e ndajmë kurrë një swap në dy transaksione.

---

## 4. Ku qëndrojmë kundrejt tregut: agjentët dhe "smart accounts"

Zgjidhja standarde e 2026-s për agjentët është **politika te niveli i çelësit**: Turnkey, Privy,
Crossmint dhe Coinbase ofrojnë çelësa në enclave me rregulla — limit shpenzimi, adresa të lejuara,
lloje transaksionesh ([Crossmint](https://www.crossmint.com/learn/agent-wallets-compared),
[Turnkey](https://www.turnkey.com/solutions/ai-agents)). Solana Agent Kit V2 kaloi te wallet-et e
integruara pikërisht për këtë. Nga ana tjetër, **Squads** ofron smart accounts me limite shpenzimi
dhe nënllogari, duke siguruar mbi 15 miliardë dollarë
([Squads](https://squads.xyz/blog/squads-smart-account-program-live-on-mainnet)).

**Dallimi ynë, i thënë saktë:** ata kufizojnë **çfarë mund të nënshkruhet**. Ne kufizojmë **çfarë
mund të bëjë një transaksion i nënshkruar**. Një politikë që thotë "mund të firmosësh swap-e deri
1000 dollarë" nuk të mbron nëse ai swap i vetëm i jep autoritet programit mbi të gjithë wallet-in.

Këto janë **plotësuese, jo konkurrente**. SDK-ja jonë duhet të rrijë pranë atyre sistemeve: agjenti
ndërton transaksionin me Bound, ekzekuton verifier-in pranë vetes, dhe pastaj i kërkon Turnkey-t ose
Privy-t firmën. Ky është pozicionimi më i fortë që kemi, dhe nuk kërkon që klienti të lëvizë asetet
në një smart account.

---

## 5. Çfarë dolëm se e kemi bërë mirë

- **Nuk përdorim mekanizmin e affiliate të Jupiter-it.** Ai kërkon që llogaria jonë e fee-së të
  futet brenda instruksionit të tyre, pikërisht ajo që rregulli R1 ndalon (gjetja B-11). Fee-ja jonë
  është instruksion i besuar dhe i verifikuar.
- **Nuk e ndajmë swap-in në disa transaksione** — kufiri i 64 llogarive e bën tundues, por dy
  transaksione do të thoshin dy nënshkrime dhe mundësi për të mbetur në gjysmë.
- **Lista e lejuar e extensions-ave**, jo e ndaluar: çdo extension i panjohur refuzohet.
- **Pragjet e matura**, jo të hamendësuara.
- **Transaksionet v1** e heqin varësinë nga RPC për tabelat e adresave — kjo konfirmon që supozimi
  ynë i vetëm i mbetur do të zhduket vetë me kohën.
- **Certifikata e përshkruar si faturë, jo provë** — e njëjta gjuhë që përdorin edhe të tjerët për
  mekanizma të ngjashëm.

---

## 6. Radha që propozoj

| | Puna | Pse tani |
| --- | --- | --- |
| 0 | Një provë reale me Phantom, të dyja llojet, për të parë saktësisht ku shtohen assertions | Gjithçka më poshtë varet nga ajo që gjendet aty |
| 1 | Pranimi i instruksioneve shtesë nga wallet-i, plus rruga `presignTransaction` | Pa këtë, Bound mund të mos punojë fare me Phantom dhe nuk punon me wallet-et e integruara |
| 2 | Mbrojtja nga sandwich me Jito, me dy mënyra dhe pa kthim të heshtur | Vlen më shumë se fee-ja jonë për swap-et e mëdha, por nuk është kusht për një alfa të vogël |
| 3 | Swap pa fee kur fee-ja është arsyeja që route-i nuk nxë | Klienti merr swap-in në vend të një refuzimi |
| 4 | SDK për agjentët, pranë Turnkey/Privy | Tregu ku garancia jonë ka vlerë më të madhe |
| 5 | Assertions tanat me Lighthouse (opsionale) | Mbrojtje në thellësi: rregullat tona të zbatuara edhe on-chain |

Pikat 1 dhe 2 duhen para publikimit. Pika 1 duhet parë nga auditori para se të zbatohet.
