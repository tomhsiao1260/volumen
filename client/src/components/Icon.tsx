/**
 * @file The symbols the board uses, drawn inline so that the page needs no icon font: a rolled
 * scroll, a fragment of one, one scan of it, and a folder.  Every path stays within the 24×24 box.
 */

interface IconShape {
  path: React.ReactNode;
  // Thicker than the default 1.5 where the symbol needs it to stay readable when small.
  width?: number;
}

const ICONS: Record<string, IconShape> = {
  /*
   * The scroll mark of the Vesuvius Challenge itself, traced from the icon on scrollprize.org: a
   * sheet whose top edge is rolled at the left and whose bottom edge is rolled at the right.  Its
   * strokes are thicker than the other symbols' on purpose — that is what keeps it readable at the
   * 15 pixels a list gives it, and it is how the original is drawn.
   */
  scroll: {
    width: 2.2,
    path: (
      <>
        <path d="M5.6 6.4H1.5V1.9h18.4V18h2.4v4.1H5.6z" />
        <path d="M19.9 18h-9.8v4.1" />
      </>
    ),
  },
  // A torn piece of one.
  fragment: { path: <path d="M6 6l6-2 6 3v9l-3 2-3-1-3 2-3-2z" /> },
  // One scan of it: a box of voxels.
  volume: {
    path: (
      <>
        <path d="M12 4l7 4v8l-7 4-7-4V8z" />
        <path d="M5 8l7 4 7-4" />
        <path d="M12 12v8" />
      </>
    ),
  },
  folder: {
    path: (
      <path d="M4 8a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    ),
  },
  back: { path: <path d="M14 6l-6 6 6 6" /> },
  plus: {
    path: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
  },
};

export type IconName =
  | "scroll"
  | "fragment"
  | "volume"
  | "folder"
  | "back"
  | "plus";

// Sized by the font size where it is used.
export function Icon({ name }: { name: IconName }) {
  const { path, width = 1.5 } = ICONS[name];
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}
