// Synthetic protocol fixtures only. EXIF claims here are NOT authenticity or trusted accuracy.
const sharp=require("sharp");
const coord=value=>`${Math.floor(value)}/1 ${Math.floor((value%1)*60)}/1 ${Math.round((((value%1)*60)%1)*600000)}/10000`;
async function rejectedOriginal(options={}) {
  const {latitude=12.662301,longitude=123.932983,time="2026:11:12 08:00:00",offset="+08:00",accuracy=null,software="Synthetic rejection fixture"}=options;
  const exif={IFD0:{Make:"Synthetic test device",Model:"Not provenance proof",Software:software},IFD2:{}};
  if(time!==null)exif.IFD2.DateTimeOriginal=time;
  if(offset!==null)exif.IFD2.OffsetTimeOriginal=offset;
  if(options.digitized)exif.IFD2.DateTimeDigitized=options.digitized;
  if(latitude!==null&&longitude!==null)exif.IFD3={GPSLatitudeRef:"N",GPSLatitude:coord(latitude),GPSLongitudeRef:"E",GPSLongitude:coord(longitude)};
  if(accuracy!==null){exif.IFD3 ||= {};exif.IFD3.GPSHPositioningError=`${accuracy}/1`;}
  if(options.dop){exif.IFD3 ||= {};exif.IFD3.GPSDOP=`${options.dop}/1`;}
  return sharp({create:{width:24,height:24,channels:3,background:options.color||"#245b3b"}}).jpeg().withMetadata({exif}).toBuffer();
}
module.exports={rejectedOriginal};
