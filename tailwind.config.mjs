/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0d1117',
          panel: '#161b22',
          elev: '#1c2128',
          hover: '#21262d'
        },
        line: '#30363d',
        txt: {
          base: '#e6edf3',
          dim: '#7d8590'
        },
        claude: '#d97757',
        copilot: '#2f81f7'
      },
      fontFamily: {
        mono: ['Cascadia Code', 'Consolas', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
}
