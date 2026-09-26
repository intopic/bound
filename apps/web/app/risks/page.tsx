import { permanentRedirect } from 'next/navigation';

/** The risks now have their place on a page of fewer, fuller pages. */
export default function Page() {
  permanentRedirect('/terms#risks');
}
