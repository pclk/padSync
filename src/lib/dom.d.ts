// Safari exposes whether a touch is a finger or the Apple Pencil.
interface Touch {
  readonly touchType?: "direct" | "stylus";
}
