import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Exclui assets estaticos + PWA assets + workspace logos
    '/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|icon-\\d+|icon-maskable-\\d+|apple-touch-icon|favicon-\\d+|veridian-symbol|veridian-wordmark|veridian-logo|fabric-login|fabric-wallpaper|workspace-logos|offline|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|json|js|map)$).*)',
  ],
};
