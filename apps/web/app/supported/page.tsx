import { permanentRedirect } from 'next/navigation';

/** The supported tokens now have their place on a page of fewer, fuller pages. */
export default function Page() {
  permanentRedirect('/security#supported');
}
