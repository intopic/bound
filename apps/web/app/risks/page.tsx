import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Risks — Orientim', description: 'What can still go wrong, and what Orientim does about it.' };

const RISKS: [string, string][] = [
  ['Price and token value', 'Tokens can lose their value at any time, and new tokens often do. Orientim guarantees the minimum you accepted for this swap, not what the token is worth afterwards.'],
  ['What a token’s issuer can do', 'Some issuers can freeze balances, mint more, or move tokens. Orientim warns before the swap; it cannot change the token.'],
  ['Third-party programs and markets', 'Jupiter and the markets it routes through are run by others. Orientim limits what they can reach to the approved amount, but cannot fix a flaw inside them.'],
  ['The network', 'A swap can be delayed, expire or fail. An expired or failed swap moves nothing but may still cost its network fee.'],
  ['An outcome not yet known', 'If the page cannot yet confirm a swap, it may still land. Orientim starts no new swap from the same wallet until the network answers.'],
  ['Your wallet and device', 'Orientim cannot protect a wallet whose seed phrase or device is compromised. Never share your seed phrase, and keep large amounts on a hardware wallet.'],
  ['Impostor sites', 'Open Orientim only at orientim.com. A copy elsewhere is not Orientim.'],
  ['Law and taxes', 'Rules on digital assets differ by country and change. You are responsible for following those that apply to you.'],
];

export default async function Page() {
  signPageChunks('risks/page');
  await connection();
  return (
    <InfoPage eyebrow="Risks" title="What can still go wrong" draft lead="Orientim removes one risk: that a swap takes more of your wallet than you approved. These remain.">
      <section>
        <ul>{RISKS.map(([name, text]) => <li key={name}><strong>{name}.</strong> {text}</li>)}</ul>
      </section>
    </InfoPage>
  );
}
