import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "padSync",
    short_name: "padSync",
    description: "Pencil notes on iPad, live on your Mac, ready for AI.",
    start_url: "/",
    display: "standalone",
    orientation: "landscape",
    background_color: "#f1f5f9",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
