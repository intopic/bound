import { permanentRedirect } from 'next/navigation';

/** The reviews are no longer published: the address leads to how Orientim protects you. */
export default function Page() {
  permanentRedirect('/security');
}
