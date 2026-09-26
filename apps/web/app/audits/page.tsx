import { permanentRedirect } from 'next/navigation';

/** The reviews now have their place on a page of fewer, fuller pages. */
export default function Page() {
  permanentRedirect('/proof#reviews');
}
