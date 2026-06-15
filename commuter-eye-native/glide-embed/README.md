# Commuter Eye Glide Arrivals Embed

This folder contains a mobile-first React web module intended for a Glide Web Embed URL. It is not a standalone site shell and intentionally avoids app navigation, browser chrome styling, or a dark iframe background.

Serve `glide-embed/index.html` from any static host and use that URL in Glide's Web Embed component.

The module:
- fetches `A24N` and `A24S` with the existing `push-arrivals?platformId=...` API format
- refreshes every 15 seconds
- supports touch pull-to-refresh when embedded on mobile
- uses the official A/D route bullet PNGs from `glide-embed/assets`
- falls back to native circular route badges if an image is unavailable
