#!/usr/bin/env python3
"""
综合示例：建筑物检测完整流程演示
演示从图像检测到结果分析的完整流程
"""

import sys
from pathlib import Path

# 添加脚本目录到路径
sys.path.insert(0, str(Path(__file__).parent / 'scripts'))

from building_detector import BuildingDetector
import json


def example_1_basic_detection():
    """示例 1: 基础建筑物检测"""
    print("\n" + "="*60)
    print("示例 1: 基础建筑物检测")
    print("="*60)

    detector = BuildingDetector()

    # 检查服务状态
    print("\n1️⃣ 检查服务状态...")
    health = detector.check_health()
    if not health:
        print("❌ 服务未启动，请先运行:")
        print("   powershell -ExecutionPolicy Bypass -File scripts\\local-vision\\start.ps1")
        return

    print(f"✅ 服务正常: {health['service']} v{health['version']}")
    print(f"   设备: {health['device']}")

    # 模拟检测（需要实际图像文件）
    print("\n2️⃣ 检测建筑物...")
    print("   📝 提示: 请准备一张航拍或卫星图像")
    print("   使用方法: detector.detect_buildings('image.jpg')")

    # 示例结果结构
    example_result = {
        "model": "yolov8n-building-seg.pt",
        "task": "buildings-seg",
        "image": {"width": 1920, "height": 1080},
        "detections": [
            {
                "class": "building",
                "confidence": 0.8523,
                "box": {"x": 245.5, "y": 189.3, "width": 156.8, "height": 203.4},
                "polygon": [[245.5, 189.3], [402.3, 191.2], [400.1, 392.7], [246.8, 390.1]]
            }
        ]
    }

    print("\n3️⃣ 示例结果结构:")
    print(json.dumps(example_result, indent=2, ensure_ascii=False))


def example_2_with_coordinates():
    """示例 2: 带地理坐标的检测"""
    print("\n" + "="*60)
    print("示例 2: 带地理坐标导出")
    print("="*60)

    detector = BuildingDetector()

    print("\n1️⃣ 准备地理范围参数...")

    # 示例：北京某区域
    image_bounds = {
        "minLon": 116.35,
        "maxLon": 116.37,
        "minLat": 39.95,
        "maxLat": 39.97,
        "imageWidth": 1920,
        "imageHeight": 1080
    }

    print(f"   经度范围: {image_bounds['minLon']} ~ {image_bounds['maxLon']}")
    print(f"   纬度范围: {image_bounds['minLat']} ~ {image_bounds['maxLat']}")

    print("\n2️⃣ 坐标转换示例...")

    # 图像坐标 -> 地理坐标
    image_point = [960, 540]  # 图像中心点
    geo_coords = detector.image_to_geo_coords([image_point], image_bounds)

    print(f"   图像坐标: {image_point}")
    print(f"   地理坐标: {geo_coords[0]}")

    print("\n3️⃣ 使用方法:")
    print("   python scripts/building_detector.py image.jpg \\")
    print("       --bounds 116.35,39.95,116.37,39.97 \\")
    print("       --format geojson")


def example_3_batch_processing():
    """示例 3: 批量处理大图像"""
    print("\n" + "="*60)
    print("示例 3: 批量处理大图像")
    print("="*60)

    print("\n1️⃣ 大图处理策略:")
    print("   - 图像分块: 2048×2048 像素")
    print("   - 重叠区域: 256 像素")
    print("   - 自动去重: IoU > 0.5")

    print("\n2️⃣ 处理流程:")
    steps = [
        "将大图切分成多个小块",
        "逐块检测建筑物",
        "坐标转换回原图",
        "去除重叠区域的重复",
        "合并导出结果"
    ]
    for i, step in enumerate(steps, 1):
        print(f"   {i}. {step}")

    print("\n3️⃣ 使用方法:")
    print("   python scripts/batch_extractor.py large_image.tif \\")
    print("       --tile-size 2048 \\")
    print("       --overlap 256 \\")
    print("       --format geojson")

    print("\n4️⃣ 性能估算:")
    print("   - 单块处理: ~13 秒")
    print("   - 8000×6000 图像: ~12块")
    print("   - 预计总时间: ~2.6 分钟")


def example_4_visualization():
    """示例 4: 结果可视化"""
    print("\n" + "="*60)
    print("示例 4: 结果可视化")
    print("="*60)

    print("\n1️⃣ 可视化工具功能:")
    features = [
        "✅ 加载 GeoJSON 文件",
        "✅ 交互式地图查看",
        "✅ 置信度过滤",
        "✅ 透明度调整",
        "✅ 点击查看详情",
        "✅ 统计信息面板"
    ]
    for feature in features:
        print(f"   {feature}")

    print("\n2️⃣ 使用方法:")
    print("   1. 在浏览器中打开: visualization/building_viewer.html")
    print("   2. 点击 '选择文件' 加载 GeoJSON")
    print("   3. 调整滑块过滤和显示效果")
    print("   4. 点击建筑物查看详细信息")

    print("\n3️⃣ 统计面板显示:")
    stats = {
        "建筑物总数": "156",
        "平均置信度": "78.3%",
        "总面积": "45.2 万 m²",
        "密度": "312 个/km²"
    }
    for label, value in stats.items():
        print(f"   {label}: {value}")


def example_5_integration():
    """示例 5: 集成到 God's Eye View"""
    print("\n" + "="*60)
    print("示例 5: 集成到 God's Eye View")
    print("="*60)

    print("\n1️⃣ 系统架构:")
    print("""
    ┌─────────────────┐
    │   浏览器 UI      │
    │  (Cesium 3D)    │
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │  Node.js 服务器  │
    │  /api/vision/*  │
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │  Python YOLO    │
    │  :8766          │
    └─────────────────┘
    """)

    print("2️⃣ 集成步骤:")
    steps = [
        "在 src/data/ 创建 buildingFootprints.js",
        "注册到 main.js 的图层系统",
        "添加 UI 控制面板",
        "实现语音命令（可选）",
        "添加 3D 拉伸效果"
    ]
    for i, step in enumerate(steps, 1):
        print(f"   {i}. {step}")

    print("\n3️⃣ API 调用示例:")
    print("""
    // JavaScript
    const response = await fetch('/api/vision/detect', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            image: 'data:image/jpeg;base64,...',
            confidence: 0.3,
            task: 'buildings-seg'
        })
    });

    const result = await response.json();
    console.log(`检测到 ${result.detections.length} 个建筑物`);
    """)


def example_6_analysis():
    """示例 6: 数据分析"""
    print("\n" + "="*60)
    print("示例 6: 建筑物数据分析")
    print("="*60)

    detector = BuildingDetector()

    print("\n1️⃣ 可分析的特征:")
    features = {
        "几何特征": ["面积", "周长", "紧凑度", "长宽比", "顶点数"],
        "空间特征": ["密度", "聚集度", "方向性", "间距分布"],
        "检测特征": ["置信度", "类别", "分割质量"]
    }
    for category, items in features.items():
        print(f"\n   {category}:")
        for item in items:
            print(f"      - {item}")

    print("\n2️⃣ 分析示例代码:")
    print("""
    import pandas as pd
    import numpy as np

    # 加载检测结果
    with open('buildings.json') as f:
        result = json.load(f)

    # 提取特征
    features = []
    for det in result['detections']:
        area = det['box']['width'] * det['box']['height']
        vertices = len(det['polygon'])
        confidence = det['confidence']

        features.append({
            'area': area,
            'vertices': vertices,
            'confidence': confidence
        })

    # 统计分析
    df = pd.DataFrame(features)
    print(df.describe())

    # 面积分布
    df['area'].hist(bins=20)
    plt.xlabel('面积 (像素²)')
    plt.ylabel('数量')
    plt.title('建筑物面积分布')
    plt.show()
    """)


def example_7_advanced():
    """示例 7: 高级应用"""
    print("\n" + "="*60)
    print("示例 7: 高级应用场景")
    print("="*60)

    scenarios = {
        "🏙️ 城市规划": [
            "建筑密度分析",
            "违章建筑识别",
            "用地类型统计",
            "与规划图对比"
        ],
        "🚨 灾害评估": [
            "灾前灾后对比",
            "受损建筑统计",
            "影响范围评估",
            "重建优先级排序"
        ],
        "🏗️ 施工监测": [
            "进度跟踪",
            "新建建筑识别",
            "拆迁监控",
            "时序变化分析"
        ],
        "📊 房地产": [
            "存量建筑统计",
            "开发强度分析",
            "竞品项目对比",
            "市场容量评估"
        ]
    }

    for scenario, tasks in scenarios.items():
        print(f"\n{scenario}")
        for task in tasks:
            print(f"   • {task}")


def main():
    """运行所有示例"""
    print("\n" + "="*70)
    print(" "*15 + "🏢 建筑物检测系统 - 综合示例")
    print("="*70)

    examples = [
        ("基础检测", example_1_basic_detection),
        ("地理坐标", example_2_with_coordinates),
        ("批量处理", example_3_batch_processing),
        ("结果可视化", example_4_visualization),
        ("系统集成", example_5_integration),
        ("数据分析", example_6_analysis),
        ("高级应用", example_7_advanced)
    ]

    print("\n可用示例:")
    for i, (name, _) in enumerate(examples, 1):
        print(f"   {i}. {name}")

    print("\n运行所有示例? (y/n) ", end="")
    choice = input().strip().lower()

    if choice == 'y':
        for name, example_func in examples:
            try:
                example_func()
                input("\n按 Enter 继续下一个示例...")
            except KeyboardInterrupt:
                print("\n\n用户中断")
                break
    else:
        print("\n提示: 单独运行特定示例:")
        print("   python examples.py  # 选择要运行的示例")

    print("\n" + "="*70)
    print("✨ 完整文档请参考:")
    print("   - 快速入门: QUICKSTART.md")
    print("   - 完整指南: building-extraction-guide.md")
    print("   - API 文档: gods-eye-view/scripts/local-vision/README.md")
    print("="*70 + "\n")


if __name__ == "__main__":
    main()
