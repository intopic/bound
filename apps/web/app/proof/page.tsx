import { permanentRedirect } from 'next/navigation';

/** The proof page is no longer published: its address leads to how Orientim protects you. */
export default function Page() {
  permanentRedirect('/security');
}
