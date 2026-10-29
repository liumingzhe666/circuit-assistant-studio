const part = (type, ref, value, x, y, rotate = 0, extra = {}) => ({ type, ref, value, x, y, rotate, ...extra });
const wire = (...points) => ({ points });

export function lowSideSchematic(voltage) {
  return {
    components: [
      part('terminal','J1','CTRL',40,240), part('resistor','RG','47Ω',125,240),
      part('mosfet','Q1','N-MOS',285,240), part('resistor','RPD','100kΩ',210,320,90),
      part('terminal','J2','LOAD−',490,155), part('terminal','J3',`LOAD+ / ${voltage}V`,490,65),
      part('diode','D1','续流',390,110,270),
      part('ground','GND','',285,410), part('ground','GND2','',210,410),
    ],
    wires: [
      wire([40,240],[86,240]), wire([164,240],[250,240]),
      wire([210,240],[210,281]), wire([210,359],[210,400]),
      wire([293,199],[293,155],[490,155]), wire([390,155],[390,147]),
      wire([490,65],[390,65],[390,73]),
      wire([293,281],[293,385],[285,385],[285,400]),
    ],
  };
}

export function bridgeRectifierSchematic(capacitanceLabel) {
  return {
    components: [
      part('terminal','J1','AC1',35,210), part('fuse','F1','FUSE',105,210),
      part('terminal','J2','AC2',400,210),
      part('diode','D1','',230,125,270), part('diode','D2','',355,125,270),
      part('diode','D3','',230,295,270), part('diode','D4','',355,295,270),
      part('electrolytic','C1',capacitanceLabel,475,235),
      part('terminal','J3','VRAW+',520,60), part('ground','GND','',475,410),
    ],
    wires: [
      wire([35,210],[70,210]), wire([140,210],[230,210]),
      wire([230,162],[230,258]), wire([355,162],[355,258]), wire([355,210],[400,210]),
      wire([230,88],[230,60],[520,60]), wire([355,88],[355,60]),
      wire([475,60],[475,205]), wire([230,332],[230,370],[475,370]),
      wire([355,332],[355,370]), wire([475,265],[475,400]),
    ],
  };
}

export function timer555Schematic(raLabel, rbLabel, capacitanceLabel) {
  return {
    components: [
      part('terminal','J1','VCC',40,60), part('terminal','J2','OUT',510,210),
      part('ic','U1','555',290,230,0,{pinProfile:'timer555'}),
      part('resistor','RA',raLabel,110,125,90), part('resistor','RB',rbLabel,110,230,90),
      part('capacitor','C1',capacitanceLabel,110,340), part('capacitor','C2','10nF',400,340),
      part('capacitor','C3','100nF',55,130,0,{labelSide:'left',labelX:-14}),
      part('ground','GND','',290,410),
    ],
    wires: [
      wire([40,60],[290,60],[290,148]), wire([110,60],[110,86]),
      wire([200,60],[200,180],[220,180]),
      wire([110,164],[110,191]), wire([110,180],[180,180],[180,230],[220,230]),
      wire([110,269],[110,310]), wire([110,295],[180,295],[180,260],[220,260]),
      wire([180,280],[220,280]), wire([360,210],[510,210]),
      wire([360,270],[400,270],[400,310]), wire([55,60],[55,100]),
      wire([55,160],[55,400],[400,400]), wire([110,370],[110,400]),
      wire([290,312],[290,400]), wire([400,370],[400,400]),
    ],
  };
}
