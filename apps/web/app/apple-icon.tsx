import { ImageResponse } from 'next/og';
import { Mark } from '@/lib/og/card';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** The home-screen icon: the mark on the page colour, since iOS rounds the corners itself. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0c1117' }}>
        <Mark size={140} />
      </div>
    ),
    size,
  );
}
