#!/usr/bin/env python3
"""
建筑物检测工具
使用本地 YOLO 服务检测影像中的建筑物并导出结果
"""

import requests
import base64
import json
from pathlib import Path
from typing import List, Dict, Tuple, Optional
import argparse


class BuildingDetector:
    """建筑物检测器"""

    def __init__(self, api_url: str = "http://127.0.0.1:8766"):
        self.api_url = api_url
        self.session = requests.Session()

    def check_health(self) -> Dict:
        """检查服务健康状态"""
        try:
            response = self.session.get(f"{self.api_url}/health", timeout=5)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"❌ 服务不可用: {e}")
            print("请先启动视觉服务: powershell -ExecutionPolicy Bypass -File scripts/local-vision/start.ps1")
            return None

    def detect_buildings(
        self,
        image_path: str,
        confidence: float = 0.25,
        task: str = "buildings-seg"
    ) -> Dict:
        """
        检测图像中的建筑物

        Args:
            image_path: 图像文件路径
            confidence: 置信度阈值 (0.05-0.95)
            task: 检测任务类型 (buildings-seg, obb, segment, detect)

        Returns:
            检测结果字典
        """
        # 读取并编码图像
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"图像文件不存在: {image_path}")

        with open(image_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        # 判断图像格式
        suffix = image_path.suffix.lower()
        mime_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp"
        }.get(suffix, "image/jpeg")

        # 构建请求
        payload = {
            "image": f"data:{mime_type};base64,{image_data}",
            "confidence": confidence,
            "task": task
        }

        print(f"🔍 正在检测建筑物...")
        print(f"   - 图像: {image_path.name}")
        print(f"   - 置信度: {confidence}")
        print(f"   - 任务: {task}")

        # 发送请求
        try:
            response = self.session.post(
                f"{self.api_url}/v1/detect",
                json=payload,
                timeout=60
            )
            response.raise_for_status()
            result = response.json()

            print(f"✅ 检测完成!")
            print(f"   - 检测到 {len(result['detections'])} 个建筑物")
            print(f"   - 使用模型: {result['model']}")
            print(f"   - 图像尺寸: {result['image']['width']}×{result['image']['height']}")

            return result

        except requests.exceptions.HTTPError as e:
            error_data = e.response.json() if e.response.content else {}
            print(f"❌ 检测失败: {error_data.get('error', {}).get('message', str(e))}")
            raise
        except Exception as e:
            print(f"❌ 请求失败: {e}")
            raise

    def export_geojson(
        self,
        detections: List[Dict],
        image_bounds: Dict,
        output_path: str
    ):
        """
        导出为 GeoJSON 格式

        Args:
            detections: 检测结果列表
            image_bounds: 图像地理范围 {"minLon": ..., "maxLon": ..., "minLat": ..., "maxLat": ...}
            output_path: 输出文件路径
        """
        features = []

        for det in detections:
            # 转换图像坐标为地理坐标
            geo_coords = self.image_to_geo_coords(
                det["polygon"],
                image_bounds
            )

            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [geo_coords]
                },
                "properties": {
                    "class": det["class"],
                    "confidence": round(det["confidence"], 4),
                    "bbox": [
                        det["box"]["x"],
                        det["box"]["y"],
                        det["box"]["x"] + det["box"]["width"],
                        det["box"]["y"] + det["box"]["height"]
                    ]
                }
            }
            features.append(feature)

        geojson = {
            "type": "FeatureCollection",
            "features": features,
            "metadata": {
                "total_buildings": len(features),
                "bounds": image_bounds
            }
        }

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, indent=2, ensure_ascii=False)

        print(f"💾 已导出 GeoJSON: {output_path}")
        print(f"   - 共 {len(features)} 个建筑物")

    def export_csv(
        self,
        detections: List[Dict],
        image_bounds: Optional[Dict],
        output_path: str
    ):
        """
        导出为 CSV 格式

        Args:
            detections: 检测结果列表
            image_bounds: 图像地理范围（可选）
            output_path: 输出文件路径
        """
        import csv

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            fieldnames = [
                "id", "class", "confidence",
                "bbox_x", "bbox_y", "bbox_width", "bbox_height",
                "polygon_vertices", "polygon_coords"
            ]

            if image_bounds:
                fieldnames.extend(["geo_polygon_wkt"])

            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()

            for i, det in enumerate(detections):
                row = {
                    "id": i + 1,
                    "class": det["class"],
                    "confidence": round(det["confidence"], 4),
                    "bbox_x": det["box"]["x"],
                    "bbox_y": det["box"]["y"],
                    "bbox_width": det["box"]["width"],
                    "bbox_height": det["box"]["height"],
                    "polygon_vertices": len(det["polygon"]),
                    "polygon_coords": json.dumps(det["polygon"])
                }

                if image_bounds:
                    geo_coords = self.image_to_geo_coords(det["polygon"], image_bounds)
                    wkt = self.coords_to_wkt(geo_coords)
                    row["geo_polygon_wkt"] = wkt

                writer.writerow(row)

        print(f"💾 已导出 CSV: {output_path}")
        print(f"   - 共 {len(detections)} 行记录")

    @staticmethod
    def image_to_geo_coords(
        polygon: List[List[float]],
        bounds: Dict
    ) -> List[List[float]]:
        """
        将图像坐标转换为地理坐标

        Args:
            polygon: 图像坐标多边形 [[x1, y1], [x2, y2], ...]
            bounds: {"minLon": ..., "maxLon": ..., "minLat": ..., "maxLat": ...,
                     "imageWidth": ..., "imageHeight": ...}

        Returns:
            地理坐标多边形 [[lon1, lat1], [lon2, lat2], ...]
        """
        min_lon = bounds["minLon"]
        max_lon = bounds["maxLon"]
        min_lat = bounds["minLat"]
        max_lat = bounds["maxLat"]
        width = bounds["imageWidth"]
        height = bounds["imageHeight"]

        geo_coords = []
        for x, y in polygon:
            lon = min_lon + (x / width) * (max_lon - min_lon)
            lat = max_lat - (y / height) * (max_lat - min_lat)
            geo_coords.append([round(lon, 6), round(lat, 6)])

        # 闭合多边形
        if geo_coords and geo_coords[0] != geo_coords[-1]:
            geo_coords.append(geo_coords[0])

        return geo_coords

    @staticmethod
    def coords_to_wkt(coords: List[List[float]]) -> str:
        """将坐标转换为 WKT 格式"""
        coord_str = ", ".join([f"{lon} {lat}" for lon, lat in coords])
        return f"POLYGON(({coord_str}))"

    def calculate_statistics(self, detections: List[Dict]) -> Dict:
        """计算检测统计信息"""
        if not detections:
            return {
                "count": 0,
                "confidence": {"min": 0, "max": 0, "mean": 0},
                "area": {"min": 0, "max": 0, "mean": 0},
                "vertices": {"min": 0, "max": 0, "mean": 0}
            }

        confidences = [d["confidence"] for d in detections]
        areas = [d["box"]["width"] * d["box"]["height"] for d in detections]
        vertices = [len(d["polygon"]) for d in detections]

        return {
            "count": len(detections),
            "confidence": {
                "min": round(min(confidences), 4),
                "max": round(max(confidences), 4),
                "mean": round(sum(confidences) / len(confidences), 4)
            },
            "area": {
                "min": round(min(areas), 2),
                "max": round(max(areas), 2),
                "mean": round(sum(areas) / len(areas), 2)
            },
            "vertices": {
                "min": min(vertices),
                "max": max(vertices),
                "mean": round(sum(vertices) / len(vertices), 1)
            }
        }


def main():
    parser = argparse.ArgumentParser(
        description="建筑物检测工具 - 使用本地 YOLO 服务",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 检测单张图像
  python building_detector.py image.jpg

  # 指定置信度和输出格式
  python building_detector.py image.jpg --confidence 0.3 --format geojson

  # 使用地理范围导出
  python building_detector.py image.jpg --bounds 116.3,39.9,116.4,40.0 --format geojson

  # 检查服务状态
  python building_detector.py --health
        """
    )

    parser.add_argument("image", nargs="?", help="输入图像路径")
    parser.add_argument(
        "--confidence", "-c",
        type=float,
        default=0.25,
        help="置信度阈值 (0.05-0.95, 默认: 0.25)"
    )
    parser.add_argument(
        "--task", "-t",
        choices=["buildings-seg", "obb", "segment", "detect"],
        default="buildings-seg",
        help="检测任务类型 (默认: buildings-seg)"
    )
    parser.add_argument(
        "--format", "-f",
        choices=["json", "geojson", "csv"],
        default="json",
        help="输出格式 (默认: json)"
    )
    parser.add_argument(
        "--output", "-o",
        help="输出文件路径 (默认: 自动生成)"
    )
    parser.add_argument(
        "--bounds", "-b",
        help="图像地理范围: minLon,minLat,maxLon,maxLat"
    )
    parser.add_argument(
        "--health",
        action="store_true",
        help="检查服务健康状态"
    )
    parser.add_argument(
        "--api-url",
        default="http://127.0.0.1:8766",
        help="API 服务地址 (默认: http://127.0.0.1:8766)"
    )

    args = parser.parse_args()

    detector = BuildingDetector(api_url=args.api_url)

    # 健康检查
    if args.health:
        health = detector.check_health()
        if health:
            print("\n📊 服务状态:")
            print(f"   - 服务: {health['service']}")
            print(f"   - 状态: {health['status']}")
            print(f"   - 版本: {health['version']}")
            print(f"   - 设备: {health['device']}")
            print(f"   - 忙碌: {health['busy']}")
            print("\n📦 已安装模型:")
            for task, info in health['models'].items():
                status = "✅" if info['installed'] else "❌"
                loaded = "🔥" if info['loaded'] else "💤"
                print(f"   {status} {loaded} {task}: {info['model']}")
        return

    if not args.image:
        parser.error("请提供图像路径，或使用 --health 检查服务状态")

    # 检测建筑物
    result = detector.detect_buildings(
        args.image,
        confidence=args.confidence,
        task=args.task
    )

    detections = result["detections"]

    # 统计信息
    stats = detector.calculate_statistics(detections)
    print(f"\n📊 统计信息:")
    print(f"   - 总数: {stats['count']}")
    print(f"   - 置信度: {stats['confidence']['min']:.2f} ~ {stats['confidence']['max']:.2f} (均值: {stats['confidence']['mean']:.2f})")
    print(f"   - 面积: {stats['area']['min']:.0f} ~ {stats['area']['max']:.0f} px² (均值: {stats['area']['mean']:.0f})")
    print(f"   - 顶点数: {stats['vertices']['min']} ~ {stats['vertices']['max']} (均值: {stats['vertices']['mean']:.1f})")

    # 导出结果
    if args.output:
        output_path = args.output
    else:
        input_path = Path(args.image)
        output_path = f"{input_path.stem}_buildings.{args.format}"

    # 解析地理范围
    image_bounds = None
    if args.bounds:
        try:
            min_lon, min_lat, max_lon, max_lat = map(float, args.bounds.split(","))
            image_bounds = {
                "minLon": min_lon,
                "maxLon": max_lon,
                "minLat": min_lat,
                "maxLat": max_lat,
                "imageWidth": result["image"]["width"],
                "imageHeight": result["image"]["height"]
            }
        except ValueError:
            print("⚠️  地理范围格式错误，将只导出图像坐标")

    # 导出
    if args.format == "json":
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"\n💾 已导出 JSON: {output_path}")

    elif args.format == "geojson":
        if not image_bounds:
            print("⚠️  GeoJSON 格式需要提供 --bounds 参数")
            print("   使用 --bounds minLon,minLat,maxLon,maxLat")
            return
        detector.export_geojson(detections, image_bounds, output_path)

    elif args.format == "csv":
        detector.export_csv(detections, image_bounds, output_path)

    print("\n✨ 完成!")


if __name__ == "__main__":
    main()
