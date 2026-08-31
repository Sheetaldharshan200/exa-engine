import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        {/* Embedded mode (Exasol Studio's Docs tab): the host app passes its
            own theme as ?theme=dark|light. Applying it to next-themes'
            storage BEFORE hydration keeps the iframe in lockstep with the
            app's toggle — cross-origin in the desktop shell, so this query
            param is the only channel. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=new URLSearchParams(location.search).get("theme");if(t==="dark"||t==="light"){localStorage.setItem("theme",t)}}catch(e){}',
          }}
        />
      </head>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
