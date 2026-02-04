# Massive Multiplayer Crossword

A collaborative crossword puzzle game with 10,000+ words across multiple languages and topics.

## Features

- **10,000+ Words**: Massive word database covering animals, food, technology, science, geography, music, sports, arts, nature, and professions
- **Multilingual**: Words from English, Spanish, French, German, Italian, Japanese, and Portuguese with English clues
- **Fun Clues**: Witty, memorable clues that make solving enjoyable
- **Real-time Multiplayer**: See other players' guesses in real-time via BroadcastChannel
- **Progress Tracking**: Track completion percentage and individual word progress
- **Leaderboard**: Compete with other players for the highest score
- **Pan & Zoom**: Navigate large puzzles easily with mouse wheel and drag

## Technology

- **React + TypeScript + Vite**: Modern web stack
- **Algorithm X (DLX)**: Knuth's Dancing Links algorithm for crossword generation
- **BroadcastChannel API**: Multi-tab synchronization
- **LocalStorage**: Persistent game state

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment

### Option 1: Vercel (Recommended)

```bash
npx vercel
```

### Option 2: Netlify

```bash
npx netlify deploy --prod --dir=dist
```

### Option 3: Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name=massive-crossword
```

### Option 4: GitHub Pages

Push to main branch and enable GitHub Pages in repository settings. The included GitHub Actions workflow will automatically build and deploy.

## How to Play

1. Click "Generate New Puzzle" to create a massive crossword
2. Click on a cell to select it
3. Type letters to fill in guesses
4. Use arrow keys to navigate
5. Press Tab to switch between across and down
6. Use mouse wheel to zoom, click and drag to pan
7. Search clues in the right panel
8. Compete with others for the highest score!

## Keyboard Shortcuts

- **A-Z**: Enter letter
- **Arrow keys**: Navigate cells
- **Tab**: Switch direction (across/down)
- **Backspace/Delete**: Move to previous cell
- **Ctrl/Cmd + Scroll**: Zoom in/out

## Credits

Built with Algorithm X (Dancing Links) as described by Donald Knuth for efficient exact cover problem solving.
