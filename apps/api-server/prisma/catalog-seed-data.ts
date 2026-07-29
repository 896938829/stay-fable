export type CatalogFacilitySeed = {
  id: string;
  code: "WIFI" | "BREAKFAST" | "PARKING" | "FAMILY";
  nameZh: string;
  displayOrder: number;
};

export type CatalogPropertySeed = {
  id: string;
  cityId: string;
  type: "HOTEL" | "HOMESTAY" | "FARM_STAY";
  nameZh: string;
  addressZh: string;
  longitude: number;
  latitude: number;
  shortDescriptionZh: string;
  descriptionZh: string;
  policiesZh: string;
  coverUrl: string;
  displayOrder: number;
  facilityCodes: CatalogFacilitySeed["code"][];
  basePrices: readonly [number, number];
};

export type CatalogPropertyMediaSeed = {
  id: string;
  propertyId: string;
  url: string;
  altZh: string;
  displayOrder: number;
};

export type CatalogRoomTypeSeed = {
  id: string;
  propertyId: string;
  nameZh: string;
  bedTypeZh: string;
  areaSqm: string;
  maxGuests: number;
  coverUrl: string;
  descriptionZh: string;
  bookingPolicyZh: string;
  displayOrder: number;
  inventory: number;
  basePriceCents: number;
};

export type CatalogDailySupplySeed = {
  roomTypeId: string;
  businessDate: string;
  salePriceCents: number;
  rackPriceCents: number;
  total: number;
};

const fixedUuid = (prefix: 2 | 3 | 4 | 5, suffix: number): string =>
  `${prefix}0000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

const unsplashUrl = (photoId: string): string => `https://images.unsplash.com/${photoId}`;

const propertyPolicies = "14:00后入住，12:00前退房；入住人需出示有效证件。";
const roomBookingPolicy = "到店前一天18:00前可免费取消，之后取消规则以报价确认为准。";

export const catalogFacilities: readonly CatalogFacilitySeed[] = [
  {
    id: fixedUuid(4, 1),
    code: "WIFI",
    nameZh: "无线网络",
    displayOrder: 10,
  },
  {
    id: fixedUuid(4, 2),
    code: "BREAKFAST",
    nameZh: "早餐",
    displayOrder: 20,
  },
  {
    id: fixedUuid(4, 3),
    code: "PARKING",
    nameZh: "停车场",
    displayOrder: 30,
  },
  {
    id: fixedUuid(4, 4),
    code: "FAMILY",
    nameZh: "亲子友好",
    displayOrder: 40,
  },
];

export const catalogProperties: readonly CatalogPropertySeed[] = [
  {
    id: fixedUuid(2, 1),
    cityId: "10000000-0000-4000-8000-000000000001",
    type: "HOTEL",
    nameZh: "西湖云栖酒店",
    addressZh: "杭州市西湖区湖滨片区",
    longitude: 120.1551,
    latitude: 30.2741,
    shortDescriptionZh: "湖滨城市旅店，适合短途度假",
    descriptionZh: "西湖云栖酒店提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。",
    policiesZh: propertyPolicies,
    coverUrl: unsplashUrl("photo-1566073771259-6a8506099945"),
    displayOrder: 10,
    facilityCodes: ["WIFI", "PARKING", "BREAKFAST"],
    basePrices: [42_800, 56_800],
  },
  {
    id: fixedUuid(2, 2),
    cityId: "10000000-0000-4000-8000-000000000001",
    type: "HOMESTAY",
    nameZh: "龙井山居",
    addressZh: "杭州市西湖区龙井片区",
    longitude: 120.1165,
    latitude: 30.2248,
    shortDescriptionZh: "龙井山间民宿，提供安静居住体验",
    descriptionZh: "龙井山居提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。",
    policiesZh: propertyPolicies,
    coverUrl: unsplashUrl("photo-1445019980597-93fa8acb246c"),
    displayOrder: 20,
    facilityCodes: ["WIFI", "PARKING", "FAMILY"],
    basePrices: [32_800, 44_800],
  },
  {
    id: fixedUuid(2, 3),
    cityId: "10000000-0000-4000-8000-000000000001",
    type: "FARM_STAY",
    nameZh: "青山田园农庄",
    addressZh: "杭州市余杭区青山片区",
    longitude: 119.9878,
    latitude: 30.2734,
    shortDescriptionZh: "青山田园农庄，适合亲子周末",
    descriptionZh: "青山田园农庄提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。",
    policiesZh: propertyPolicies,
    coverUrl: unsplashUrl("photo-1500530855697-b586d89ba3ee"),
    displayOrder: 30,
    facilityCodes: ["WIFI", "PARKING", "FAMILY"],
    basePrices: [26_800, 38_800],
  },
  {
    id: fixedUuid(2, 4),
    cityId: "10000000-0000-4000-8000-000000000002",
    type: "HOTEL",
    nameZh: "筑城观山酒店",
    addressZh: "贵阳市观山湖区中心片区",
    longitude: 106.6227,
    latitude: 26.6477,
    shortDescriptionZh: "观山湖城市旅店，交通便利",
    descriptionZh: "筑城观山酒店提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。",
    policiesZh: propertyPolicies,
    coverUrl: unsplashUrl("photo-1522708323590-d24dbb6b0267"),
    displayOrder: 10,
    facilityCodes: ["WIFI", "PARKING", "BREAKFAST"],
    basePrices: [39_800, 52_800],
  },
  {
    id: fixedUuid(2, 5),
    cityId: "10000000-0000-4000-8000-000000000002",
    type: "HOMESTAY",
    nameZh: "黔灵巷居",
    addressZh: "贵阳市云岩区黔灵片区",
    longitude: 106.7043,
    latitude: 26.6049,
    shortDescriptionZh: "黔灵街巷民宿，适合慢旅行",
    descriptionZh: "黔灵巷居提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。",
    policiesZh: propertyPolicies,
    coverUrl: unsplashUrl("photo-1542314831-068cd1dbfeeb"),
    displayOrder: 20,
    facilityCodes: ["WIFI", "PARKING", "FAMILY"],
    basePrices: [29_800, 41_800],
  },
  {
    id: fixedUuid(2, 6),
    cityId: "10000000-0000-4000-8000-000000000002",
    type: "FARM_STAY",
    nameZh: "花溪稻田农庄",
    addressZh: "贵阳市花溪区田园片区",
    longitude: 106.6732,
    latitude: 26.4371,
    shortDescriptionZh: "花溪田园农庄，临近自然景观",
    descriptionZh: "花溪稻田农庄提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。",
    policiesZh: propertyPolicies,
    coverUrl: unsplashUrl("photo-1564501049412-61c2a3083791"),
    displayOrder: 30,
    facilityCodes: ["WIFI", "PARKING", "FAMILY"],
    basePrices: [23_800, 35_800],
  },
];

export const catalogPropertyMedia: readonly CatalogPropertyMediaSeed[] = catalogProperties.map(
  (property, index) => ({
    id: fixedUuid(5, index + 1),
    propertyId: property.id,
    url: property.coverUrl,
    altZh: `${property.nameZh}外观`,
    displayOrder: 10,
  }),
);

export const catalogRoomTypes: readonly CatalogRoomTypeSeed[] = catalogProperties.flatMap(
  (property, propertyIndex) => {
    const firstRoomNumber = propertyIndex * 2 + 1;
    return [
      {
        id: fixedUuid(3, firstRoomNumber),
        propertyId: property.id,
        nameZh: "舒适大床房",
        bedTypeZh: "1张1.8米大床",
        areaSqm: "28.00",
        maxGuests: 2,
        coverUrl: property.coverUrl,
        descriptionZh: "配备独立卫浴和基础洗护用品。",
        bookingPolicyZh: roomBookingPolicy,
        displayOrder: 10,
        inventory: propertyIndex === 0 ? 1 : 3,
        basePriceCents: property.basePrices[0],
      },
      {
        id: fixedUuid(3, firstRoomNumber + 1),
        propertyId: property.id,
        nameZh: "家庭双床房",
        bedTypeZh: "2张1.35米单床",
        areaSqm: "38.00",
        maxGuests: 4,
        coverUrl: property.coverUrl,
        descriptionZh: "适合家庭入住，配备独立卫浴和基础洗护用品。",
        bookingPolicyZh: roomBookingPolicy,
        displayOrder: 20,
        inventory: 2,
        basePriceCents: property.basePrices[1],
      },
    ];
  },
);

const catalogStartDate = Date.UTC(2026, 6, 30);

export const catalogDailySupply: readonly CatalogDailySupplySeed[] = catalogRoomTypes.flatMap(
  (room) =>
    Array.from({ length: 60 }, (_, offset) => {
      const businessDate = new Date(catalogStartDate + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const salePriceCents = room.basePriceCents + (offset % 7) * 1_000;
      return {
        roomTypeId: room.id,
        businessDate,
        salePriceCents,
        rackPriceCents: salePriceCents + 6_000,
        total: room.inventory,
      };
    }),
);
