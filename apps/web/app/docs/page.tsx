import { permanentRedirect } from 'next/navigation';

/** The docs' earlier address: the developer docs, with the section the link named. */
export default function Page() {
  permanentRedirect('/developers');
}
