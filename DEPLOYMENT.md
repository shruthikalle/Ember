# Deployment Guide

## Quick Deploy to Vercel

1. **Install Vercel CLI** (if not already installed):
```bash
npm install -g vercel
```

2. **Deploy**:
```bash
vercel
```

Follow the prompts to deploy your application.

## Deploy to Vercel via GitHub

1. Go to [vercel.com](https://vercel.com)
2. Click "Add New Project"
3. Import your GitHub repository: `shruthikalle/ethdenver`
4. Vercel will auto-detect the Vite configuration
5. Click "Deploy"

Your app will be live at `https://your-project.vercel.app`

## Deploy to Netlify

1. **Install Netlify CLI**:
```bash
npm install -g netlify-cli
```

2. **Build and deploy**:
```bash
npm run build
netlify deploy --prod --dir=dist
```

## Deploy to AWS Amplify

1. Go to [AWS Amplify Console](https://console.aws.amazon.com/amplify/)
2. Click "New app" → "Host web app"
3. Connect your GitHub repository
4. Configure build settings:
   - Build command: `npm run build`
   - Output directory: `dist`
5. Click "Save and deploy"

## Environment Variables

For production deployment, set these environment variables:

```env
NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org
OPENAI_API_KEY=sk-...
```

In Vercel/Netlify/Amplify, add these in the project settings under "Environment Variables".

## Custom Domain

### Vercel
1. Go to project settings
2. Click "Domains"
3. Add your custom domain
4. Update DNS records as instructed

### Netlify
1. Go to "Domain settings"
2. Click "Add custom domain"
3. Follow DNS configuration steps

## CI/CD

The application is ready for continuous deployment. Any push to the main branch will automatically trigger a new deployment on Vercel/Netlify/Amplify if configured.

## Performance Optimization

The production build is already optimized with:
- Code splitting
- Tree shaking
- CSS minification
- Gzip compression
- Asset optimization

Typical build size:
- HTML: ~0.5 KB
- CSS: ~14.7 KB (3.5 KB gzipped)
- JS: ~208 KB (65 KB gzipped)

## Monitoring

Consider adding:
- [Sentry](https://sentry.io) for error tracking
- [Google Analytics](https://analytics.google.com) for usage analytics
- [Vercel Analytics](https://vercel.com/analytics) for performance monitoring
