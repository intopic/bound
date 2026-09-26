import { permanentRedirect } from 'next/navigation';

/** The security page's earlier address. */
export default function Page() {
  permanentRedirect('/security');
}
