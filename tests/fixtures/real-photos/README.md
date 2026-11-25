# Original phone photo fixtures

Derived from the test fixtures of [exifr](https://github.com/MikeKovarik/exifr) (MIT License, Copyright (c) 2017 Mike Kovařík),
commit 6cbf6e921688faf7723e1f2e0b9e672d1f0aa21c: `heic-iphone.heic`, `heic-iphone7.heic`, `issue-exifr-35.heic`,
`IMG_20180725_163423.jpg` and `heic-empty.heic`.

Each file keeps the original phone's container and metadata byte for byte; only the compressed picture data is replaced with zeros
and the file is gzipped, so the files stay small. `expected.json` records what the original, unmodified file contains; the test
checks that these copies give exactly the same result. They cannot be displayed.
