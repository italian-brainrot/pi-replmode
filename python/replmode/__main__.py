"""`python -m replmode` — start a channel daemon."""

import sys

from .daemon import main

if __name__ == "__main__":
    sys.exit(main())
