import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/pool-and-billiards-club_inventory-management-system/',
  plugins: [react()],
})
