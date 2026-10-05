#!/usr/bin/env python3
"""
批量建筑物提取工具
支持大区域分块处理和结果合并
"""

import requests
import base64
import json
from pathlib import Path
from typing import List, Dict, Tuple, Optional
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import time
from tempfile import TemporaryDirectory


@dataclass
class TileInfo:
    """图像分块信息"""
    id: str
    bounds: Dict
    path: Optional[Path] = None
    detections: List[Dict] = None


class BatchBuildingExtractor:
    """批量建筑物提取器"""

    def __init__(
        self,
        api_url: str = "http://127.0.0.1:8766",
        tile_size: int = 1024,
        overlap: int = 128,
        max_workers: int = 1  # YOLO服务同时只能处理1个请求
    ):
        if tile_size <= 0 or not 0 <= overlap < tile_size:
            raise ValueError("tile_size must be positive and 0 <= overlap < tile_size")
        self.api_url = api_url
        self.tile_size = tile_size
        self.overlap = overlap
        self.max_workers = max_workers
        self.session = requests.Session()

    def create_tile_grid(
        self,
        image_width: int,
        image_height: int
    ) -> List[TileInfo]:
        """
        创建图像分块网格

        Args:
            image_width: 图像宽度
            image_height: 图像高度

        Returns:
            分块信息列表
        """
        tiles = []
        stride = self.tile_size - self.overlap

        for row_idx, y in enumerate(range(0, image_height, stride)):
            for col_idx, x in enumerate(range(0, image_width, stride)):
                x_end = min(x + self.tile_size, image_width)
                y_end = min(y + self.tile_size, image_height)

                tile = TileInfo(
                    id=f"tile_{row_idx}_{col_idx}",
                    bounds={
                        "x": x,
                        "y": y,
                        "width": x_end - x,
                        "height": y_end - y
                    }
                )
                tiles.append(tile)

        print(f"📐 创建了 {len(tiles)} 个分块:")
        print(f"   - 分块尺寸: {self.tile_size}×{self.tile_size}")
        print(f"   - 重叠区域: {self.overlap} px")
        print(f"   - 步长: {stride} px")

        return tiles

    def crop_tile(self, image_path: Path, tile: TileInfo, temp_dir: Path) -> Path:
        """
        裁剪分块图像

        Args:
            image_path: 原始图像路径
            tile: 分块信息

        Returns:
            分块图像路径
        """
        from PIL import Image

        crop_box = (
            tile.bounds["x"],
            tile.bounds["y"],
            tile.bounds["x"] + tile.bounds["width"],
            tile.bounds["y"] + tile.bounds["height"]
        )

        tile_path = temp_dir / f"{tile.id}.png"
        with Image.open(image_path) as img:
            with img.crop(crop_box) as tile_img:
                tile_img.save(tile_path)

        return tile_path

    def detect_tile(
        self,
        tile_path: Path,
        confidence: float = 0.25
    ) -> List[Dict]:
        """
        检测单个分块中的建筑物

        Args:
            tile_path: 分块图像路径
            confidence: 置信度阈值

        Returns:
            检测结果列表
        """
        with open(tile_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        payload = {
            "image": f"data:image/png;base64,{image_data}",
            "confidence": confidence,
            "task": "buildings-seg"
        }

        response = self.session.post(
            f"{self.api_url}/v1/detect",
            json=payload,
            timeout=60
        )
        response.raise_for_status()
        result = response.json()

        return result["detections"]

    def process_large_image(
        self,
        image_path: str,
        confidence: float = 0.25,
        geo_bounds: Optional[Dict] = None
    ) -> Dict:
        """
        处理大尺寸图像

        Args:
            image_path: 图像路径
            confidence: 置信度阈值
            geo_bounds: 地理范围（可选）

        Returns:
            处理结果
        """
        from PIL import Image

        image_path = Path(image_path)
        print(f"\n🖼️  正在处理大图: {image_path.name}")

        # 获取图像尺寸
        img = Image.open(image_path)
        width, height = img.size
        img.close()

        print(f"   - 尺寸: {width}×{height}")

        # 创建分块
        tiles = self.create_tile_grid(width, height)

        # 处理每个分块
        print(f"\n🔄 开始处理分块...")
        start_time = time.time()

        all_detections = []

        with TemporaryDirectory(prefix="gev-building-tiles-") as temp_dir:
            for i, tile in enumerate(tiles, 1):
                print(f"   [{i}/{len(tiles)}] 处理 {tile.id}...", end=" ")

                # 裁剪分块
                tile_path = self.crop_tile(image_path, tile, Path(temp_dir))

                try:
                    # 检测建筑物
                    detections = self.detect_tile(tile_path, confidence)

                    # 将坐标转换回原始图像坐标系
                    for det in detections:
                        det["polygon"] = [
                            [x + tile.bounds["x"], y + tile.bounds["y"]]
                            for x, y in det["polygon"]
                        ]
                        det["box"]["x"] += tile.bounds["x"]
                        det["box"]["y"] += tile.bounds["y"]
                        det["tile_id"] = tile.id

                    all_detections.extend(detections)
                    print(f"✅ 发现 {len(detections)} 个")

                except Exception as e:
                    print(f"❌ 失败: {e}")

                finally:
                    # 清理临时文件
                    tile_path.unlink(missing_ok=True)

        elapsed = time.time() - start_time

        # 去重
        print(f"\n🔧 去除重叠区域的重复检测...")
        unique_detections = self.remove_duplicates(all_detections)

        print(f"\n✅ 处理完成!")
        print(f"   - 总检测数: {len(all_detections)}")
        print(f"   - 去重后: {len(unique_detections)}")
        print(f"   - 耗时: {elapsed:.1f} 秒")
        print(f"   - 平均每块: {elapsed/len(tiles):.2f} 秒")

        return {
            "image": {
                "path": str(image_path),
                "width": width,
                "height": height
            },
            "tiles": len(tiles),
            "detections": unique_detections,
            "geo_bounds": geo_bounds,
            "stats": {
                "total_detected": len(all_detections),
                "after_dedup": len(unique_detections),
                "processing_time": round(elapsed, 2)
            }
        }

    def calculate_iou(self, box1: Dict, box2: Dict) -> float:
        """
        计算两个边界框的 IoU

        Args:
            box1, box2: {"x": ..., "y": ..., "width": ..., "height": ...}

        Returns:
            IoU 值 (0-1)
        """
        x1_min = box1["x"]
        y1_min = box1["y"]
        x1_max = x1_min + box1["width"]
        y1_max = y1_min + box1["height"]

        x2_min = box2["x"]
        y2_min = box2["y"]
        x2_max = x2_min + box2["width"]
        y2_max = y2_min + box2["height"]

        # 计算交集
        x_inter_min = max(x1_min, x2_min)
        y_inter_min = max(y1_min, y2_min)
        x_inter_max = min(x1_max, x2_max)
        y_inter_max = min(y1_max, y2_max)

        if x_inter_max < x_inter_min or y_inter_max < y_inter_min:
            return 0.0

        inter_area = (x_inter_max - x_inter_min) * (y_inter_max - y_inter_min)

        # 计算并集
        box1_area = box1["width"] * box1["height"]
        box2_area = box2["width"] * box2["height"]
        union_area = box1_area + box2_area - inter_area

        return inter_area / union_area if union_area > 0 else 0.0

    def remove_duplicates(
        self,
        detections: List[Dict],
        iou_threshold: float = 0.5
    ) -> List[Dict]:
        """
        使用 NMS 去除重复检测

        Args:
            detections: 检测结果列表
            iou_threshold: IoU 阈值

        Returns:
            去重后的检测列表
        """
        if not detections:
            return []

        # 按置信度排序
        sorted_dets = sorted(
            detections,
            key=lambda x: x["confidence"],
            reverse=True
        )

        keep = []

        for det in sorted_dets:
            # 检查是否与已保留的检测重叠
            is_duplicate = False

            for kept_det in keep:
                iou = self.calculate_iou(det["box"], kept_det["box"])
                if iou > iou_threshold:
                    is_duplicate = True
                    break

            if not is_duplicate:
                keep.append(det)

        removed = len(detections) - len(keep)
        if removed > 0:
            print(f"   - 移除了 {removed} 个重复检测")

        return keep


def main():
    parser = argparse.ArgumentParser(
        description="批量建筑物提取工具 - 支持大图分块处理",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 处理大尺寸图像（自动分块）
  python batch_extractor.py large_image.tif

  # 指定分块参数
  python batch_extractor.py image.jpg --tile-size 2048 --overlap 256

  # 带地理范围导出 GeoJSON
  python batch_extractor.py image.tif --bounds 116.3,39.9,116.4,40.0 --format geojson
        """
    )

    parser.add_argument("image", help="输入图像路径")
    parser.add_argument(
        "--confidence", "-c",
        type=float,
        default=0.25,
        help="置信度阈值 (默认: 0.25)"
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=1024,
        help="分块尺寸 (默认: 1024)"
    )
    parser.add_argument(
        "--overlap",
        type=int,
        default=128,
        help="重叠区域大小 (默认: 128)"
    )
    parser.add_argument(
        "--iou-threshold",
        type=float,
        default=0.5,
        help="去重 IoU 阈值 (默认: 0.5)"
    )
    parser.add_argument(
        "--bounds", "-b",
        help="图像地理范围: minLon,minLat,maxLon,maxLat"
    )
    parser.add_argument(
        "--format", "-f",
        choices=["json", "geojson"],
        default="json",
        help="输出格式 (默认: json)"
    )
    parser.add_argument(
        "--output", "-o",
        help="输出文件路径 (默认: 自动生成)"
    )

    args = parser.parse_args()

    # 解析地理范围
    geo_bounds = None
    if args.bounds:
        try:
            min_lon, min_lat, max_lon, max_lat = map(float, args.bounds.split(","))
            geo_bounds = {
                "minLon": min_lon,
                "maxLon": max_lon,
                "minLat": min_lat,
                "maxLat": max_lat
            }
        except ValueError:
            print("❌ 地理范围格式错误: minLon,minLat,maxLon,maxLat")
            return

    # 创建提取器
    extractor = BatchBuildingExtractor(
        tile_size=args.tile_size,
        overlap=args.overlap
    )

    # 处理图像
    result = extractor.process_large_image(
        args.image,
        confidence=args.confidence,
        geo_bounds=geo_bounds
    )

    # 准备输出
    if args.output:
        output_path = Path(args.output)
    else:
        input_path = Path(args.image)
        output_path = Path(f"{input_path.stem}_batch_buildings.{args.format}")

    # 导出结果
    if args.format == "json":
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"\n💾 已导出 JSON: {output_path}")

    elif args.format == "geojson":
        if not geo_bounds:
            print("❌ GeoJSON 格式需要提供 --bounds 参数")
            return

        # 构建 GeoJSON
        from building_detector import BuildingDetector

        detector = BuildingDetector()

        geo_bounds_with_size = {
            **geo_bounds,
            "imageWidth": result["image"]["width"],
            "imageHeight": result["image"]["height"]
        }

        detector.export_geojson(
            result["detections"],
            geo_bounds_with_size,
            output_path
        )

    print("\n✨ 全部完成!")


if __name__ == "__main__":
    main()
