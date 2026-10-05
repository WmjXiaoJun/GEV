import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from batch_extractor import BatchBuildingExtractor, main


class BatchSafetyTests(unittest.TestCase):
    def test_cli_preserves_existing_tile_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                Path('temp_tiles').mkdir()
                sentinel = Path('temp_tiles/tile_0_0.png')
                sentinel.write_bytes(b'user data')
                Image.new('RGB', (8, 8)).save('input.png')
                with patch.object(sys, 'argv', ['batch_extractor.py', 'input.png']), \
                     patch.object(BatchBuildingExtractor, 'detect_tile', return_value=[]), \
                     contextlib.redirect_stdout(io.StringIO()):
                    main()
                self.assertTrue(sentinel.exists(), 'existing user tile was removed')
                self.assertEqual(sentinel.read_bytes(), b'user data')
            finally:
                os.chdir(previous)

    def test_temporary_tiles_cleaned_on_request_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'input.png'
            Image.new('RGB', (8, 8)).save(image)
            observed = []

            def fail(tile_path, _confidence):
                observed.append(tile_path)
                raise RuntimeError('simulated service unavailable')

            extractor = BatchBuildingExtractor()
            with patch.object(extractor, 'detect_tile', side_effect=fail), \
                 contextlib.redirect_stdout(io.StringIO()):
                extractor.process_large_image(str(image))
            self.assertTrue(observed)
            self.assertFalse(observed[0].exists())
            self.assertFalse(observed[0].parent.exists())

    def test_rejects_invalid_tile_stride(self):
        for size, overlap in [(0, 0), (8, 8), (8, -1)]:
            with self.subTest(size=size, overlap=overlap), self.assertRaises(ValueError):
                BatchBuildingExtractor(tile_size=size, overlap=overlap)


if __name__ == '__main__':
    unittest.main()
