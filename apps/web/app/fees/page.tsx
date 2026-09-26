import { permanentRedirect } from 'next/navigation';

/** The fees now have their place on a page of fewer, fuller pages. */
export default function Page() {
  permanentRedirect('/security#fees');
}
